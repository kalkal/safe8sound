import {
  PlanSchema,
  celsius,
  err,
  ok,
  pct,
  toolError,
  type ErrorEnvelope,
  type Forecast,
  type HomeProfile,
  type LevelStep,
  type Plan,
  type PlanComfortInput,
  type PlanWarning,
  type GuaranteeId,
  type PlanStep,
  type Preferences,
  type Result,
  type Snapshot,
} from '@cold-reserve/contracts';
import { acLimitW, buildLadder, epsBaseLoadW, candidateSteps, controlFromSteps, darkWindow, dutyCycle, humidityBandWithin, nextHumidityMode, nextNightWindow, seasonFor, withTargets, type HumidityMode } from '@cold-reserve/core';
import { buildContext, counterfactualOf, currentControls, nightCoolingLimit, projectFrom, rejectionOf, reserveOf, runGuard, safeUntil, type CandidatePlan, type GuardContext, type GuardInput, type GuardVerdict, type SafeLimit } from '@cold-reserve/guard';
import type { ToolContext } from '../../tool.js';
import { localIso, localTimeText } from '../../time.js';
import type { ComfortHome, ComfortPlanDeps } from './deps.js';
import { lastResortActions, lastResortWindow } from './last-resort.js';
import { recordRejection } from './rejections.js';

// plan_comfort, the first of the two phases (plan §9.2): read-only on the home, it proposes a plan and
// saves it as `proposed` with an expiry. "The model proposes, the guard decides":
// - with overrides (setpoint, rooms) the guard checks exactly that plan and a refusal goes back to the
//   model with the reason and the nearest allowed value;
// - without them the planner walks the ladder from comfort down and proposes the first rung the guard
//   accepts. The plan carries the ladder from that rung down, so later steps down need no new consent.

export interface Inputs {
  readonly home: ComfortHome;
  readonly snapshot: Snapshot;
  readonly forecast: Forecast;
  readonly profile: HomeProfile;
  readonly preferences: Preferences;
}

interface Attempt {
  readonly candidate: CandidatePlan;
  readonly verdict: GuardVerdict;
  readonly guardInput: GuardInput;
}

/** The home, its latest snapshot, the forecast and the preferences; any failure comes back unchanged. */
export async function loadInputs(deps: ComfortPlanDeps, ctx: ToolContext): Promise<Result<Inputs, ErrorEnvelope>> {
  const home = deps.homes(ctx.homeId);
  if (home === undefined) return err(toolError('home_not_found', 'This client is not linked to a configured home.'));
  const [snapshot, preferences] = await Promise.all([home.source.snapshot(), deps.preferencesFor(ctx.homeId, home.profile)]);
  if (!snapshot.ok) return snapshot;
  if (!preferences.ok) return preferences;
  return ok({ home, snapshot: snapshot.value, forecast: home.forecast(), profile: home.profile, preferences: preferences.value });
}

/**
 * The season and the night-recovery mode the guard judges a plan in, from the goal and the current state:
 * propose and apply must use the same rules, or apply would revalidate an auto plan in the wrong season.
 */
export function guardFrame(
  deps: Pick<ComfortPlanDeps, 'config'>,
  goal: Plan['goal'],
  inputs: Pick<Inputs, 'snapshot' | 'forecast' | 'preferences'>,
): Pick<GuardInput, 'season' | 'nightRecoveryMode'> {
  const safe = inputs.snapshot.rooms.find((r) => r.id === inputs.preferences.safeRoomId);
  const elderly = safe?.occupants.some((role) => deps.config.elderlyRoles.includes(role)) ?? false;
  return { season: seasonFor(goal, inputs.forecast.hourly, inputs.preferences), nightRecoveryMode: elderly ? 'elderly' : 'standard' };
}

export async function planComfort(deps: ComfortPlanDeps, input: PlanComfortInput, ctx: ToolContext): Promise<Result<Plan, ErrorEnvelope>> {
  const loaded = await loadInputs(deps, ctx);
  if (!loaded.ok) return loaded;
  const { snapshot, forecast, profile, preferences } = loaded.value;
  // Off grid the plan is projected on the EPS circuits: without their load nothing is assumed (#107).
  if (!snapshot.gridAvailable) {
    const eps = epsBaseLoadW(profile);
    if (!eps.ok) return eps;
  }
  const unknown = input.roomIds?.find((id) => !profile.rooms.some((r) => r.id === id));
  if (unknown !== undefined) {
    return err(toolError('unknown_room', `There is no room "${unknown}" in this home.`, { details: { field: 'roomIds', roomId: unknown } }));
  }

  const { season, nightRecoveryMode } = guardFrame(deps, input.goal, loaded.value);
  const occupied = snapshot.rooms.filter((r) => r.occupants.length > 0).map((r) => r.id);
  const ladder = buildLadder({ season, goal: input.goal, profile, preferences, occupied, config: deps.config.planner });
  const guardInput: GuardInput = {
    plan: { horizonAt: snapshot.ts, steps: [], ladder },
    snapshot,
    forecast,
    profile,
    preferences,
    season,
    model: deps.model,
    config: deps.guard,
    nightRecoveryMode,
  };
  const overridden = input.setpointC !== undefined || input.roomIds !== undefined;
  // Every candidate tried, for the last resort.
  const tried: Attempt[] = [];
  const recorded = (a: Attempt): Attempt => (tried.push(a), a);
  const attempt = (index: number): Attempt | undefined => {
    const rung = ladder[index];
    if (rung === undefined) return undefined;
    // With night cooling first (the night-recovery target), then without it.
    const withNight = overridden ? undefined : recorded(tryRung(deps, guardInput, ladder.slice(index), rung, false, undefined, undefined, true));
    return withNight?.verdict.ok === true ? withNight : recorded(tryRung(deps, guardInput, ladder.slice(index), withOverrides(rung, input), overridden, input.setpointC));
  };
  // Before the last resort: the essential rung paced inside the hour, from the longest run down.
  const cycled = (cycle: { onMinutes: number; periodMinutes: number }): Attempt | undefined => {
    const index = ladder.length - 1;
    const rung = ladder[index];
    if (rung === undefined) return undefined;
    const withNight = recorded(tryRung(deps, guardInput, ladder.slice(index), rung, false, undefined, cycle, true));
    return withNight.verdict.ok ? withNight : recorded(tryRung(deps, guardInput, ladder.slice(index), rung, false, undefined, cycle));
  };

  let chosen: Attempt | undefined;
  let last: Attempt | undefined;
  for (let i = 0; i < (overridden ? 1 : ladder.length) && chosen === undefined; i++) {
    last = attempt(i);
    if (last?.verdict.ok === true) chosen = last;
  }
  for (const cycle of overridden ? [] : deps.config.planner.dutyCycles) {
    if (chosen !== undefined) break;
    const paced = cycled(cycle);
    if (paced?.verdict.ok === true) chosen = paced;
  }
  const store = deps.storeFor(ctx.homeId, { correlationId: ctx.correlationId });
  // No plan holds every guarantee: the planner's own candidates still give the safest one, as long as it
  // breaks no hard limit. A plan the model proposed is answered with the refusal.
  const safest = chosen === undefined && !overridden ? lastResortOf(tried, deps, guardInput) : undefined;
  if (chosen === undefined && safest !== undefined) chosen = safest.attempt;
  if (chosen === undefined) {
    const rejection = last === undefined ? undefined : rejectionOf(last.verdict);
    if (last !== undefined) {
      await recordRejection(store, last.verdict, deps, { correlationId: ctx.correlationId, homeId: ctx.homeId });
    }
    return err(rejection ?? toolError('unexpected_error', 'The planner produced no candidate.'));
  }

  const nowMs = deps.clock.now();
  const counterfactual = counterfactualOf({ ...chosen.guardInput, plan: chosen.candidate });
  const draft = {
    schemaVersion: 1,
    id: deps.newPlanId(),
    homeId: ctx.homeId,
    status: 'proposed',
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + deps.config.planTtlMinutes * 60_000).toISOString(),
    horizonAt: chosen.candidate.horizonAt,
    goal: input.goal,
    ladder: chosen.candidate.ladder,
    steps: chosen.candidate.steps,
    reserveWh: Math.round(chosen.verdict.reserveWh),
    // The floor holds only with the grid up; with the grid down the reserve is the budget itself.
    ...(snapshot.gridAvailable ? { reserveFloorSocPct: chosen.verdict.reserveFloorSocPct } : {}),
    gridAvailable: snapshot.gridAvailable,
    guarantees: chosen.verdict.guarantees,
    forecastConfidence: forecast.confidence,
    confidenceReason: forecast.confidenceReason,
    sourceOrigin: snapshot.origin,
    advisoryOnly: loaded.value.home.readOnly,
    ...(chosen.verdict.nightRecovery === undefined ? {} : { nightRecovery: chosen.verdict.nightRecovery }),
    ...(warningsOf(chosen, safest).length === 0 ? {} : { warnings: warningsOf(chosen, safest) }),
    ...(safest === undefined ? {} : { lastResort: safest.lastResort }),
    ...(counterfactual === undefined ? {} : { counterfactual }),
  };
  const parsed = PlanSchema.safeParse(draft);
  if (!parsed.success) return err(toolError('output_schema_violation', 'The proposed plan does not match its schema.'));
  const saved = await store.savePlan(parsed.data);
  if (!saved.ok) return saved;
  if (safest !== undefined) {
    // Audit trail of a last resort: the guard did refuse it, and the log says it was proposed anyway.
    await recordRejection(store, safest.attempt.verdict, deps, { correlationId: ctx.correlationId, homeId: ctx.homeId }, parsed.data.id);
    deps.logger.log({
      ts: new Date(deps.clock.now()).toISOString(),
      level: 'info',
      component: 'mcp-server',
      message: `Last-resort plan proposed: safe until ${safest.lastResort.safeUntil}, limited by ${safest.lastResort.limitedBy}.`,
      correlationId: ctx.correlationId,
      homeId: ctx.homeId,
      details: { planId: parsed.data.id, failed: safest.attempt.verdict.guarantees.filter((g) => !g.ok).map((g) => g.id) },
    });
  }
  return ok(parsed.data);
}

const HARD_LIMITS: readonly GuaranteeId[] = ['storm_reserve', 'inverter_limit', 'battery_power'];

interface LastResort {
  readonly attempt: Attempt;
  readonly lastResort: NonNullable<Plan['lastResort']>;
  readonly warning: PlanWarning;
}

/**
 * The safest of the candidates when none holds every guarantee: among those that break no hard limit
 * (storm reserve, inverter, battery power) but fail a guarantee, the one whose safe room stays safe the
 * longest; the first, the most comfortable, on a tie. Undefined when every candidate breaks a hard limit.
 */
function lastResortOf(tried: readonly Attempt[], deps: ComfortPlanDeps, guardInput: GuardInput): LastResort | undefined {
  const { preferences, snapshot, profile, season } = guardInput;
  const nowMs = Date.parse(snapshot.ts);
  const stepMs = deps.guard.projection.stepMinutes * 60_000;
  // At night the health threshold of the night-recovery mode wins over a higher safety maximum (#160).
  const coolingMaxAt = nightCoolingLimit({ maxC: preferences.safety.cooling.maxC, tz: profile.location.tz, night: deps.guard.nightRecovery, mode: guardInput.nightRecoveryMode });
  const limitAt = (ms: number) => (season === 'heating' ? preferences.safety.heating.minC : coolingMaxAt(ms));
  let best: { attempt: Attempt; untilMs: number; limitedBy: SafeLimit; points: GuardContext['points'] } | undefined;
  for (const a of tried) {
    const guarantees = a.verdict.guarantees;
    if (guarantees.every((g) => g.ok) || guarantees.some((g) => HARD_LIMITS.includes(g.id) && !g.ok)) continue;
    const context = buildContext({ ...a.guardInput, plan: a.candidate });
    const control = controlFromSteps(a.candidate.steps, currentControls(snapshot));
    // A point is what the previous step left: the plan dried the room into it if that step was drying.
    const driesAt = (ms: number) => control(ms - stepMs).find((c) => c.id === preferences.safeRoomId)?.hvac?.mode === 'dry';
    const end = safeUntil(context.points, { nowMs, graceMinutes: deps.guard.safeRoom.graceMinutes, roomId: preferences.safeRoomId, season, safety: preferences.safety, driesAt, coolingMaxAt });
    // No breach inside the horizon: what fails is something else (the pace, the night), and "safe until"
    // would name a limit that is not there. Such a candidate is not a last resort.
    if (end === undefined) continue;
    if (best === undefined || end.ms > best.untilMs) best = { attempt: a, untilMs: end.ms, limitedBy: end.limitedBy, points: context.points };
  }
  if (best === undefined) return undefined;
  const { limitedBy } = best;
  const safeHours = Math.round(((best.untilMs - nowMs) / 3_600_000) * 100) / 100;
  // In the home's time zone, as the family message and the guard's reasons say it.
  const safeUntilIso = localIso(best.untilMs, profile.location.tz);
  const room = profile.rooms.find((r) => r.id === preferences.safeRoomId)?.name ?? preferences.safeRoomId;
  const { cooling, heating, humidity } = preferences.safety;
  const limitThen = coolingMaxAt(best.untilMs);
  const then =
    limitedBy === 'battery'
      ? 'the battery runs out'
      : limitedBy === 'humidity'
        ? `the humidity leaves its ${String(humidity.minPct)}-${String(humidity.maxPct)} % band`
        : season === 'heating'
          ? `the room drops below its ${String(heating.minC)} °C minimum`
          : limitThen < cooling.maxC
            ? `the room goes above ${String(limitThen)} °C, the night limit`
            : `the room goes above its ${String(cooling.maxC)} °C maximum`;
  // The honest window (#160): the limit kept until safeUntil, then how far the room goes and by when; the
  // summary says it (the warning keeps its 300 characters for the reason).
  const window = lastResortWindow(best.points, { nowMs, untilMs: best.untilMs, roomId: preferences.safeRoomId, season, limitAt, claimsUntil: limitedBy !== 'battery' });
  return {
    attempt: best.attempt,
    lastResort: {
      safeUntil: safeUntilIso,
      safeHours,
      limitedBy,
      ...(window === undefined ? {} : { comfortLimitC: celsius(window.comfortLimitC), worstC: celsius(window.worstC), worstAt: localIso(window.worstAtMs, profile.location.tz) }),
      actions: lastResortActions(season),
    },
    warning: {
      code: 'last_resort_plan',
      message: `No plan keeps the ${room} within its limits until the next recharge: safe for about ${String(safeHours)} hours, until ${localTimeText(safeUntilIso)}; then ${then}.`.slice(0, 300),
    },
  };
}

function warningsOf(chosen: Attempt, safest: LastResort | undefined): PlanWarning[] {
  return [...chosen.verdict.warnings, ...(safest === undefined ? [] : [safest.warning])];
}

function withOverrides(rung: LevelStep, input: PlanComfortInput): LevelStep {
  return input.roomIds === undefined ? rung : { ...rung, roomIds: input.roomIds };
}

/**
 * One rung: steps, then battery targets from the projection of those steps, then the guard. A plan the
 * model proposed is checked as it is: no room is switched off to fit the inverter, the guard decides.
 */
function tryRung(
  deps: ComfortPlanDeps,
  guardInput: GuardInput,
  ladder: LevelStep[],
  rung: LevelStep,
  exact: boolean,
  setpointC?: number,
  cycle?: { onMinutes: number; periodMinutes: number },
  nightCooling = false,
): Attempt {
  const { snapshot, profile, preferences, season } = guardInput;
  const atMs = Date.parse(snapshot.ts);
  const baseLoadPeakW = Math.max(...deps.guard.projection.baseLoadWByLocalHour);
  const base = candidateSteps({
    ladderStep: rung,
    comfortC: season === 'heating' ? preferences.comfortC.heating : preferences.comfortC.cooling,
    atMs,
    profile,
    priority: preferences.roomPriority,
    budgetW: exact ? Number.POSITIVE_INFINITY : acLimitW(profile, snapshot.gridAvailable) - baseLoadPeakW,
    humidityByRoom: Object.fromEntries(snapshot.rooms.flatMap((r) => (r.humidityPct === undefined ? [] : [[r.id, r.humidityPct]]))),
    config: deps.config.planner,
    ...(setpointC === undefined ? {} : { setpointC }),
  });
  // Until the next recharge the forecast shows, else as far as the weather is known.
  const forecastEndMs = Math.max(atMs, ...guardInput.forecast.hourly.map((h) => Date.parse(h.ts) + 3_600_000));
  const recharge = darkWindow({
    forecast: guardInput.forecast,
    fromMs: atMs,
    pvPeakW: profile.pvPeakW,
    lossRatio: deps.model.pv.lossRatio,
    essentialLoadW: deps.guard.reserve.essentialLoadW,
  });
  const horizonMs = recharge?.toMs ?? forecastEndMs;
  const cycleEndMs = horizonMs;
  const paced =
    cycle === undefined
      ? base
      : base.flatMap((s) => (s.roomId === preferences.safeRoomId && s.hvacMode !== 'off' ? dutyCycle(s, { ...cycle, fromMs: atMs, toMs: cycleEndMs }) : [s]));
  const nightly = season === 'cooling' && nightCooling ? withNightCooling(paced, deps, guardInput, atMs, horizonMs) : paced;
  // A plan the model proposed is checked exactly as it is; the planner's own plans follow the humidity.
  const humid = season === 'cooling' && !exact ? withHumidityControl(nightly, deps, guardInput, horizonMs) : nightly;
  const untargeted: CandidatePlan = { horizonAt: new Date(horizonMs).toISOString(), steps: humid, ladder };
  const context = buildContext({ ...guardInput, plan: untargeted });
  // Each target is the lowest SOC the projection expects until the next target (see withTargets).
  const socMin = (fromMs: number, toMs: number) => {
    const socs = context.points.filter((p) => p.ms >= fromMs && p.ms < toMs).map((p) => p.socPct);
    return socs.length === 0 ? (context.points.at(-1)?.socPct ?? snapshot.batterySocPct) : Math.min(...socs);
  };
  const steps = withTargets(humid, { socMin, fromMs: atMs, toMs: context.horizonMs, safeRoomId: preferences.safeRoomId, config: deps.config.planner });
  const candidate: CandidatePlan = { horizonAt: new Date(context.horizonMs).toISOString(), steps, ladder };
  return { candidate, verdict: runGuard({ ...guardInput, plan: candidate }), guardInput };
}

/**
 * Night recovery in the plan itself: during the night window the safe room is cooled a little below the
 * night threshold (26 °C, or 24 °C for an elderly person), then goes back to the rung's setting. Outside the
 * window nothing changes; inside it, any pacing cycle of the safe room gives way to steady cooling. Whether it
 * dries or cools is left to withHumidityControl.
 */
function withNightCooling(steps: readonly PlanStep[], deps: ComfortPlanDeps, guardInput: GuardInput, atMs: number, horizonMs: number): PlanStep[] {
  const { profile, preferences } = guardInput;
  const cfg = deps.guard.nightRecovery;
  const window = nextNightWindow(atMs, horizonMs, profile.location.tz, cfg);
  const safe = steps.filter((s) => s.roomId === preferences.safeRoomId).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))[0];
  const cools = profile.rooms.find((r) => r.id === preferences.safeRoomId)?.hvacUnits.some((u) => u.modes.includes('cool')) ?? false;
  if (window === undefined || safe === undefined || !cools) return [...steps];
  const nightC = Math.min(safe.setpointC, cfg.thresholdC[guardInput.nightRecoveryMode] - cfg.referenceSetpointMarginK);
  const inside = (s: PlanStep) => s.roomId === preferences.safeRoomId && Date.parse(s.ts) >= window.startMs && Date.parse(s.ts) < window.endMs;
  const mode = safe.hvacMode === 'dry' ? 'dry' : 'cool';
  const night: PlanStep = { ...safe, ts: new Date(window.startMs).toISOString(), hvacMode: mode, setpointC: celsius(Math.round(nightC * 10) / 10) };
  const morning: PlanStep[] = window.endMs < horizonMs ? [{ ...safe, ts: new Date(window.endMs).toISOString() }] : [];
  return [...steps.filter((s) => !inside(s) && !(s.roomId === preferences.safeRoomId && Date.parse(s.ts) === window.endMs)), night, ...morning];
}

/**
 * Dry or cool in the safe room, step by step until the horizon, from its projected humidity (nextHumidityMode,
 * with hysteresis): dry while the humid evening and night air would push the room above the band, cool once
 * dry would push it below. One mode for the whole evening and night either over-humidifies or over-dries.
 * Setpoints, fans and pacing stay as planned; only a dry or cool setting changes mode. The modes come from one
 * closed-loop projection and become plan steps, so the guard's projection of the plan is the same.
 */
function withHumidityControl(steps: readonly PlanStep[], deps: ComfortPlanDeps, guardInput: GuardInput, horizonMs: number): PlanStep[] {
  const { profile, preferences, snapshot } = guardInput;
  const safeId = preferences.safeRoomId;
  const modes = profile.rooms.find((r) => r.id === safeId)?.hvacUnits.flatMap((u) => u.modes) ?? [];
  const own = steps.filter((s) => s.roomId === safeId).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (!modes.includes('dry') || !modes.includes('cool') || own.length === 0) return [...steps];
  const switches = (s: PlanStep | undefined) => s !== undefined && (s.hvacMode === 'dry' || s.hvacMode === 'cool');
  const inForce = (ms: number) => own.filter((s) => Date.parse(s.ts) <= ms).at(-1);

  // Aim inside the person's limits, or the planner would propose plans its own guard refuses. The mode is
  // decided at every projection step (5 minutes): dry takes about 3 points of RH off per step, so one step of
  // overshoot past an edge stays within the margin (config `marginPct`, 3).
  const band = humidityBandWithin(deps.config.planner.humidityBand, preferences.safety.humidity);
  const changes: { ms: number; mode: HumidityMode }[] = [];
  let mode: HumidityMode | undefined;
  const planned = controlFromSteps(steps, currentControls(snapshot));
  const dischargeFloorPct = snapshot.gridAvailable ? reserveOf(guardInput).reserveFloorSocPct : pct(profile.battery.minSocHwPct);
  projectFrom(
    guardInput,
    (ms, rooms) => {
      if (!switches(inForce(ms))) return planned(ms);
      const rh = rooms.find((r) => r.id === safeId)?.humidityPct ?? 0;
      const next = nextHumidityMode(mode, rh, band);
      if (next !== mode) changes.push({ ms, mode: next });
      mode = next;
      return planned(ms).map((c) => (c.id === safeId && c.hvac !== undefined ? { ...c, hvac: { ...c.hvac, mode: next } } : c));
    },
    { toMs: horizonMs, dischargeFloorPct },
  );

  // The same control as plan steps: every dry or cool setting takes the mode in force, and each change of
  // mode between two settings becomes a step of its own.
  const modeAt = (ms: number) => changes.filter((c) => c.ms <= ms).at(-1)?.mode;
  const rewritten = steps.map((s) => (s.roomId === safeId && switches(s) ? { ...s, hvacMode: modeAt(Date.parse(s.ts)) ?? s.hvacMode } : s));
  const added = changes.flatMap((c): PlanStep[] => {
    const setting = inForce(c.ms);
    if (setting === undefined || Date.parse(setting.ts) === c.ms) return [];
    return [{ ...setting, ts: new Date(c.ms).toISOString(), hvacMode: c.mode }];
  });
  return [...rewritten, ...added];
}
