import {
  PlanSchema,
  celsius,
  err,
  ok,
  toolError,
  type ErrorEnvelope,
  type Forecast,
  type HomeProfile,
  type LevelStep,
  type Plan,
  type PlanComfortInput,
  type PlanStep,
  type Preferences,
  type Result,
  type Snapshot,
} from '@cold-reserve/contracts';
import { acLimitW, buildLadder, candidateSteps, darkWindow, dutyCycle, nextNightWindow, seasonFor, withTargets } from '@cold-reserve/core';
import { buildContext, counterfactualOf, rejectionOf, runGuard, type CandidatePlan, type GuardInput, type GuardVerdict } from '@cold-reserve/guard';
import type { ToolContext } from '../../tool.js';
import type { ComfortHome, ComfortPlanDeps } from './deps.js';
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
  const attempt = (index: number): Attempt | undefined => {
    const rung = ladder[index];
    if (rung === undefined) return undefined;
    // With night cooling first (the night-recovery target), then without it.
    const withNight = overridden ? undefined : tryRung(deps, guardInput, ladder.slice(index), rung, false, undefined, undefined, true);
    return withNight?.verdict.ok === true ? withNight : tryRung(deps, guardInput, ladder.slice(index), withOverrides(rung, input), overridden, input.setpointC);
  };
  // Last resort before refusing: the essential rung paced inside the hour, from the longest run down.
  const cycled = (cycle: { onMinutes: number; periodMinutes: number }): Attempt | undefined => {
    const index = ladder.length - 1;
    const rung = ladder[index];
    if (rung === undefined) return undefined;
    const withNight = tryRung(deps, guardInput, ladder.slice(index), rung, false, undefined, cycle, true);
    return withNight.verdict.ok ? withNight : tryRung(deps, guardInput, ladder.slice(index), rung, false, undefined, cycle);
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
  const store = deps.storeFor(ctx.homeId);
  if (chosen === undefined) {
    const rejection = last === undefined ? undefined : rejectionOf(last.verdict);
    if (last !== undefined) {
      const recorded = await recordRejection(store, last.verdict, deps.clock);
      if (!recorded.ok) return recorded;
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
    reserveFloorSocPct: chosen.verdict.reserveFloorSocPct,
    guarantees: chosen.verdict.guarantees,
    forecastConfidence: forecast.confidence,
    confidenceReason: forecast.confidenceReason,
    sourceOrigin: snapshot.origin,
    advisoryOnly: loaded.value.home.readOnly,
    ...(chosen.verdict.nightRecovery === undefined ? {} : { nightRecovery: chosen.verdict.nightRecovery }),
    ...(chosen.verdict.warnings.length === 0 ? {} : { warnings: chosen.verdict.warnings }),
    ...(counterfactual === undefined ? {} : { counterfactual }),
  };
  const parsed = PlanSchema.safeParse(draft);
  if (!parsed.success) return err(toolError('output_schema_violation', 'The proposed plan does not match its schema.'));
  const saved = await store.savePlan(parsed.data);
  if (!saved.ok) return saved;
  return ok(parsed.data);
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
  const nightly = season === 'cooling' && nightCooling ? withNightCooling(paced, deps, guardInput, atMs, horizonMs, rung.preferredModes.includes('dry')) : paced;
  const untargeted: CandidatePlan = { horizonAt: new Date(horizonMs).toISOString(), steps: nightly, ladder };
  const context = buildContext({ ...guardInput, plan: untargeted });
  // Each target is the lowest SOC the projection expects until the next target (see withTargets).
  const socMin = (fromMs: number, toMs: number) => {
    const socs = context.points.filter((p) => p.ms >= fromMs && p.ms < toMs).map((p) => p.socPct);
    return socs.length === 0 ? (context.points.at(-1)?.socPct ?? snapshot.batterySocPct) : Math.min(...socs);
  };
  const steps = withTargets(nightly, { socMin, fromMs: atMs, toMs: context.horizonMs, safeRoomId: preferences.safeRoomId, config: deps.config.planner });
  const candidate: CandidatePlan = { horizonAt: new Date(context.horizonMs).toISOString(), steps, ladder };
  return { candidate, verdict: runGuard({ ...guardInput, plan: candidate }), guardInput };
}

/**
 * Night recovery in the plan itself: during the night window the safe room is cooled a little below the
 * night threshold (26 °C, or 24 °C for an elderly person) in the rung's mode (dry stays dry), then goes back to
 * the rung's setting. Outside the
 * window nothing changes; inside it, any pacing cycle of the safe room gives way to steady cooling.
 */
function withNightCooling(steps: readonly PlanStep[], deps: ComfortPlanDeps, guardInput: GuardInput, atMs: number, horizonMs: number, rungPrefersDry: boolean): PlanStep[] {
  const { profile, preferences } = guardInput;
  const cfg = deps.guard.nightRecovery;
  const window = nextNightWindow(atMs, horizonMs, profile.location.tz, cfg);
  const safe = steps.filter((s) => s.roomId === preferences.safeRoomId).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))[0];
  const cools = profile.rooms.find((r) => r.id === preferences.safeRoomId)?.hvacUnits.some((u) => u.modes.includes('cool')) ?? false;
  if (window === undefined || safe === undefined || !cools) return [...steps];
  const nightC = Math.min(safe.setpointC, cfg.thresholdC[guardInput.nightRecoveryMode] - cfg.referenceSetpointMarginK);
  const inside = (s: PlanStep) => s.roomId === preferences.safeRoomId && Date.parse(s.ts) >= window.startMs && Date.parse(s.ts) < window.endMs;
  // Dry keeps drying while it cools: used whenever the rung prefers it (night air is humid).
  const mode = safe.hvacMode === 'dry' || rungPrefersDry ? 'dry' : 'cool';
  const night: PlanStep = { ...safe, ts: new Date(window.startMs).toISOString(), hvacMode: mode, setpointC: celsius(Math.round(nightC * 10) / 10) };
  const morning: PlanStep[] = window.endMs < horizonMs ? [{ ...safe, ts: new Date(window.endMs).toISOString() }] : [];
  return [...steps.filter((s) => !inside(s) && !(s.roomId === preferences.safeRoomId && Date.parse(s.ts) === window.endMs)), night, ...morning];
}
