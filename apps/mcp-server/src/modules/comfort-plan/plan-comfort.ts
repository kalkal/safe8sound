import {
  PlanSchema,
  REAL_HOME_ID,
  celsius,
  err,
  formatTemp,
  ok,
  pct,
  toolError,
  type ErrorEnvelope,
  type Forecast,
  type HomeProfile,
  type LevelStep,
  type TempUnit,
  type NightRecovery,
  type Plan,
  type PlanComfortInput,
  type PlanWarning,
  type GuaranteeId,
  type PlanStep,
  type Preferences,
  type Result,
  type Snapshot,
} from '@cold-reserve/contracts';
import { acLimitW, buildLadder, epsBaseLoadW, candidateSteps, controlFromSteps, darkWindow, dutyCycle, humidityBandWithin, nextHumidityMode, nextNightWindow, orderSurplusRooms, seasonFor, surplusWindow, unconvertedFahrenheit, withTargets, type HumidityMode } from '@cold-reserve/core';
import { buildContext, counterfactualOf, currentControls, holdSafeRoom, projectFrom, rejectionOf, reserveOf, runGuard, safeRoomLimitAt, safeRoomLimitKindAt, safeUntil, type CandidatePlan, type GuardContext, type GuardInput, type GuardVerdict, type SafeLimit } from '@cold-reserve/guard';
import { homeDetail, isSandbox } from '../../sandbox-log.js';
import { withModelHint, type ToolContext } from '../../tool.js';
import { localIso, localTimeText } from '@cold-reserve/core';
import type { ComfortHome, ComfortPlanDeps } from './deps.js';
import { lastResortActions, lastResortThen, lastResortWindow, limitCrossedAt, loweredLimit } from './last-resort.js';
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
  /** Where the solar surplus went, when the guard accepted the plan with it (#203). */
  readonly surplus?: NonNullable<Plan['surplus']>;
  /** The guarantees the plan with the surplus failed, when the guard refused it and the plan without it stands. */
  readonly surplusRefused?: readonly GuaranteeId[];
}

/** The home, its latest snapshot, the forecast and the preferences; any failure comes back unchanged. */
export async function loadInputs(deps: ComfortPlanDeps, ctx: ToolContext): Promise<Result<Inputs, ErrorEnvelope>> {
  const home = deps.homes(ctx.homeId);
  if (home === undefined) return err(toolError('home_not_found', 'This client is not linked to a configured home.'));
  const [snapshot, preferences] = await Promise.all([home.source.snapshot(), deps.preferencesFor(ctx.homeId, home.profile)]);
  if (!snapshot.ok) return snapshot;
  if (!preferences.ok) return preferences;
  // Every projection reads the weather hour by hour: without one it cannot run, so say so as a value (#238).
  const forecast = home.forecast();
  if (forecast.hourly.length === 0) return err(toolError('forecast_unavailable', 'No weather hour to plan with.'));
  return ok({ home, snapshot: snapshot.value, forecast, profile: home.profile, preferences: preferences.value });
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

const LAST_RESORT_HINT = 'Call plan_comfort again with only the goal: the answer is the last resort.';

/** The longest error message the contract allows. */
const MESSAGE_MAX = 300;

/** The rooms as "Name (id)", as many as fit in `budget` characters; the rest are counted, never cut mid-name (#274). */
export function roomsText(rooms: readonly { id: string; name: string }[], budget: number): string {
  const labels = rooms.map((r) => `${r.name} (${r.id})`);
  for (let n = labels.length; n > 0; n--) {
    const more = labels.length - n;
    const text = `${labels.slice(0, n).join(', ')}${more > 0 ? ` and ${String(more)} more` : ''}`;
    if (text.length <= budget) return text;
  }
  return `${String(labels.length)} rooms`;
}

/** The unit of the texts for this call (#306): the sandbox's choice, °C otherwise. */
const unitOf = (deps: ComfortPlanDeps, ctx: ToolContext): TempUnit => deps.homes(ctx.homeId)?.units ?? 'C';

export async function planComfort(deps: ComfortPlanDeps, input: PlanComfortInput, ctx: ToolContext): Promise<Result<Plan, ErrorEnvelope>> {
  const loaded = await loadInputs(deps, ctx);
  if (!loaded.ok) return loaded;
  const { snapshot, forecast, profile, preferences } = loaded.value;
  // Off grid the plan is projected on the EPS circuits: without their load nothing is assumed (#107).
  if (!snapshot.gridAvailable) {
    const eps = epsBaseLoadW(profile);
    if (!eps.ok) return eps;
  }
  // Inputs are always °C (#306 review): in a °F sandbox a setpoint no room is ever cooled or heated to is a °F number
  // the model did not convert. Refused with the °C to send, never planned at 161.6 °F.
  const unconverted = input.setpointC === undefined ? undefined : unconvertedFahrenheit('setpointC', input.setpointC, unitOf(deps, ctx));
  if (unconverted !== undefined) return err(unconverted);
  const unknown = input.roomIds?.find((id) => !profile.rooms.some((r) => r.id === id));
  if (unknown !== undefined) {
    // The rooms there are, as "Name (id)", so the model retries with a real id instead of guessing (#274).
    const head = `There is no room "${unknown.slice(0, 64)}" in this home. The rooms are: `;
    return err(toolError('unknown_room', `${head}${roomsText(profile.rooms, MESSAGE_MAX - head.length - 1)}.`, { details: { field: 'roomIds', roomId: unknown } }));
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
    // The guard's words in the unit the sandbox chose (#306); it computes in °C either way.
    displayUnit: unitOf(deps, ctx),
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
  // The last resort is the hold of the safe room (#24, decision A): the same control storm mode's safe hours
  // read, as plan steps, checked by the guard like any plan. The other candidates only when the hold does not qualify.
  const holdFailed = (error: ErrorEnvelope) => {
    deps.logger.log({
      ts: new Date(deps.clock.now()).toISOString(),
      level: 'warn',
      component: 'mcp-server',
      message: 'The hold of the safe room could not be projected: the last resort comes from the candidates.',
      correlationId: ctx.correlationId,
      ...(isSandbox(ctx.homeId) ? {} : { homeId: ctx.homeId }),
      code: error.code,
      category: error.category,
      details: { event: 'last_resort_hold_failed', ...homeDetail(ctx.homeId) },
    });
  };
  // Whether a last resort is needed is the candidates' (or the hold's) safe room failing (#160); once it is, the
  // hold is the last resort even when the hold itself fails only the pace, so the plan and the storm card name
  // the same time (#24 decision A; #248, approved in #248).
  const holds = chosen === undefined && !overridden ? holdAttempts(deps, guardInput, holdFailed) : [];
  const needed = [...tried, ...holds].some(needsLastResort);
  const fromHold = needed ? lastResortOf(holds, deps, guardInput, { anyFailure: true }) : undefined;
  const safest = fromHold ?? (chosen === undefined && !overridden ? lastResortOf(tried, deps, guardInput) : undefined);
  if (chosen === undefined && safest !== undefined) chosen = safest.attempt;
  // A plan the model proposed and the guard refused (#202): when the planner's own plan holds, that plan is the
  // answer, saved and applicable, with a short note of the refusal. Never only a refusal when a plan holds.
  let refusedProposal: { code: ErrorEnvelope['code']; message: string } | undefined;
  if (chosen === undefined && overridden && last !== undefined) {
    const refusal = rejectionOf(last.verdict, guardInput.displayUnit);
    const holds = refusal === undefined ? undefined : firstPassing(deps, guardInput, ladder);
    if (refusal !== undefined && holds !== undefined) {
      // The guard's no to the proposal stays in the audit trail.
      await recordRejection(store, last.verdict, deps, { correlationId: ctx.correlationId, homeId: ctx.homeId });
      refusedProposal = { code: refusal.code, message: refusal.message };
      chosen = holds;
    }
  }
  if (chosen === undefined) {
    const refused = last === undefined ? undefined : rejectionOf(last.verdict, guardInput.displayUnit);
    // The receipt's badge and its "simulated data" notice (#198 review): the data origin, and the real home as a
    // flag, never a home id (a sandbox id stays out of tool output).
    // A refused proposal when only the last resort is left: the model asks again with only the goal, so the
    // person hears the last resort and its two yeses (#202 follow-up). The hold's failure is logged by that call.
    const lastResortLeft = refused !== undefined && overridden && lastResortOf(holdAttempts(deps, guardInput, () => undefined), deps, guardInput) !== undefined;
    // The hint is for the model: it reaches the text it reads, never the message a card shows (#272).
    const rejection =
      refused === undefined
        ? undefined
        : { ...refused, details: { ...refused.details, origin: snapshot.origin, ...(ctx.homeId === REAL_HOME_ID ? { realHome: true as const } : {}) } };
    if (last !== undefined) {
      await recordRejection(store, last.verdict, deps, { correlationId: ctx.correlationId, homeId: ctx.homeId });
    }
    if (rejection === undefined) return err(toolError('unexpected_error', 'The planner produced no candidate.'));
    return err(lastResortLeft ? withModelHint(rejection, LAST_RESORT_HINT) : rejection);
  }

  const nowMs = deps.clock.now();
  const roomName = profile.rooms.find((r) => r.id === preferences.safeRoomId)?.name ?? preferences.safeRoomId;
  const counterfactual = counterfactualOf({ ...chosen.guardInput, plan: chosen.candidate });
  const draft = {
    schemaVersion: 1,
    id: deps.newPlanId(),
    homeId: ctx.homeId,
    status: 'proposed',
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + deps.config.planTtlMinutes * 60_000).toISOString(),
    // In the home's time zone: the voice says the same time the card shows (#160).
    horizonAt: localIso(Date.parse(chosen.candidate.horizonAt), profile.location.tz),
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
    ...(warningsOf(chosen, safest, roomName, unitOf(deps, ctx)).length === 0 ? {} : { warnings: warningsOf(chosen, safest, roomName, unitOf(deps, ctx)) }),
    ...(safest === undefined ? {} : { lastResort: safest.lastResort }),
    ...(refusedProposal === undefined ? {} : { refusedProposal }),
    ...(ctx.turnId === undefined ? {} : { proposedInTurn: ctx.turnId }),
    ...(counterfactual === undefined ? {} : { counterfactual }),
    ...(chosen.surplus === undefined ? {} : { surplus: chosen.surplus }),
  };
  const parsed = PlanSchema.safeParse(draft);
  if (!parsed.success) return err(toolError('output_schema_violation', 'The proposed plan does not match its schema.'));
  const saved = await store.savePlan(parsed.data);
  if (!saved.ok) return saved;
  if (chosen.surplusRefused !== undefined) {
    // The scene must be explainable: why the surplus went to the grid after all.
    deps.logger.log({
      ts: new Date(deps.clock.now()).toISOString(),
      level: 'info',
      component: 'mcp-server',
      message: `Solar surplus not used: the safety check refused the plan with it (${chosen.surplusRefused.join(', ')}).`,
      correlationId: ctx.correlationId,
      ...(isSandbox(ctx.homeId) ? {} : { homeId: ctx.homeId }),
      details: { event: 'surplus_refused', planId: parsed.data.id, failed: [...chosen.surplusRefused], ...homeDetail(ctx.homeId) },
    });
  }
  if (safest !== undefined) {
    // Audit trail of a last resort: the guard did refuse it, and the log says it was proposed anyway.
    await recordRejection(store, safest.attempt.verdict, deps, { correlationId: ctx.correlationId, homeId: ctx.homeId }, parsed.data.id);
    deps.logger.log({
      ts: new Date(deps.clock.now()).toISOString(),
      level: 'info',
      component: 'mcp-server',
      message: `Last-resort plan proposed: safe until ${safest.lastResort.safeUntil}, limited by ${safest.lastResort.limitedBy}.`,
      correlationId: ctx.correlationId,
      // A visitor's sandbox id never reaches a log line (#134): it is said as "sandbox".
      ...(isSandbox(ctx.homeId) ? {} : { homeId: ctx.homeId }),
      details: {
        event: 'last_resort_proposed',
        source: fromHold === undefined ? 'candidates' : 'hold',
        planId: parsed.data.id,
        failed: safest.attempt.verdict.guarantees.filter((g) => !g.ok).map((g) => g.id),
        ...homeDetail(ctx.homeId),
      },
    });
  }
  return ok(parsed.data);
}

/** The guarantees a last resort may never break: only the comfort ones are relaxed (#160). */
export const HARD_LIMITS: readonly GuaranteeId[] = ['storm_reserve', 'inverter_limit', 'battery_power'];

interface LastResort {
  readonly attempt: Attempt;
  readonly lastResort: NonNullable<Plan['lastResort']>;
  readonly warning: PlanWarning;
}

/**
 * The safest of the candidates when none holds every guarantee: among those that break no hard limit
 * (storm reserve, inverter, battery power) but fail the safe room's comfort or its night recovery, the one whose safe room stays safe the
 * longest; the first, the most comfortable, on a tie. Undefined when every candidate breaks a hard limit.
 */
/** A candidate that breaks no hard limit but fails the safe room's comfort or its night recovery (#160). */
function needsLastResort(a: Attempt): boolean {
  const guarantees = a.verdict.guarantees;
  if (guarantees.some((g) => HARD_LIMITS.includes(g.id) && !g.ok)) return false;
  return guarantees.some((g) => g.id === 'safe_room_comfort' && !g.ok) || a.verdict.nightRecovery?.status === 'unmet';
}

/** `anyFailure`: the hold, once a last resort is needed, qualifies on any failure that is not a hard limit. */
function lastResortOf(tried: readonly Attempt[], deps: ComfortPlanDeps, guardInput: GuardInput, opts: { anyFailure?: boolean } = {}): LastResort | undefined {
  const { preferences, snapshot, profile, season } = guardInput;
  const nowMs = Date.parse(snapshot.ts);
  const stepMs = deps.guard.projection.stepMinutes * 60_000;
  // At night the health threshold of the night-recovery mode wins over a higher safety maximum (#160).
  // The same limit storm mode's safe hours use (holdSafeRoom, #24): one rule for "safe until".
  const limitAt = safeRoomLimitAt(guardInput);
  let best: { attempt: Attempt; untilMs: number; limitedBy: SafeLimit; points: GuardContext['points'] } | undefined;
  for (const a of tried) {
    const guarantees = a.verdict.guarantees;
    if (guarantees.some((g) => HARD_LIMITS.includes(g.id) && !g.ok)) continue;
    // Only the safe room's own limits make a last resort (#160): a plan that fails only the pace stays a refusal.
    if (opts.anyFailure !== true && !needsLastResort(a)) continue;
    const context = buildContext({ ...a.guardInput, plan: a.candidate });
    const control = controlFromSteps(a.candidate.steps, currentControls(snapshot));
    // A point is what the previous step left: the plan dried the room into it if that step was drying.
    const driesAt = (ms: number) => control(ms - stepMs).find((c) => c.id === preferences.safeRoomId)?.hvac?.mode === 'dry';
    const end = safeUntil(context.points, { nowMs, graceMinutes: deps.guard.safeRoom.graceMinutes, roomId: preferences.safeRoomId, season, safety: preferences.safety, driesAt, coolingMaxAt: limitAt, elderly: guardInput.nightRecoveryMode === 'elderly' });
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
  const limitThen = safeRoomLimitKindAt(guardInput)(best.untilMs);
  const then = lastResortThen({ limitedBy, season, limitThenC: limitThen.limitC, limitKind: limitThen.kind, ...preferences.safety, unit: guardInput.displayUnit ?? 'C' });
  // The honest window (#160): from safeUntil, how far past the limit in force the room goes and by when; the
  // summary says it (the warning keeps its 300 characters for the reason).
  const window = lastResortWindow(best.points, { untilMs: best.untilMs, roomId: preferences.safeRoomId, season, limitAt });
  // When the battery ends the safe hours, the room holds its limit a while by inertia: when it crosses it, from the
  // same projection (#272), so the text says both times in one sentence, with the limit crossed there.
  const crossed = limitedBy === 'battery' && window !== undefined ? limitCrossedAt(best.points, { untilMs: best.untilMs, roomId: preferences.safeRoomId, season, limitAt }) : undefined;
  // Decided from the data, not from the time (#166): the limit came down at safeUntil with the room above it.
  const lowered =
    window !== undefined && limitedBy === 'temperature' && season !== 'heating'
      ? loweredLimit(best.points, { untilMs: best.untilMs, stepMs, roomId: preferences.safeRoomId, limitAt })
      : undefined;
  return {
    attempt: best.attempt,
    lastResort: {
      safeUntil: safeUntilIso,
      safeHours,
      limitedBy,
      ...(window === undefined ? {} : { comfortLimitC: celsius(window.comfortLimitC), worstC: celsius(window.worstC), worstAt: localIso(window.worstAtMs, profile.location.tz) }),
      ...(crossed === undefined ? {} : { limitCrossedAt: localIso(crossed.atMs, profile.location.tz), limitCrossedC: celsius(crossed.limitC) }),
      ...(lowered === undefined ? {} : { loweredLimitC: celsius(lowered) }),
      actions: lastResortActions(season),
    },
    warning: {
      code: 'last_resort_plan',
      message: `No plan keeps the ${room} within its limits until the next recharge: safe for about ${String(safeHours)} hours, until ${localTimeText(safeUntilIso)}; then ${then}.`.slice(0, 300),
    },
  };
}

/**
 * Next to a last resort the battery ends, the night warning's hours variant ends at the same clock time as the
 * window, with no second duration (#272): the person hears one end time; the night's hours stay in nightRecovery.
 * Only when the room crosses the night threshold itself (or never crosses it); the heat-budget variant (the hours
 * are reached) and a crossing of another limit keep the guard's words (#272 review).
 */
export function alignedNightWarning(w: PlanWarning, lr: Plan['lastResort'], night: NightRecovery | undefined, roomName: string, unit: TempUnit = 'C'): PlanWarning {
  if (w.code !== 'night_recovery_infeasible' || lr?.limitedBy !== 'battery' || night === undefined) return w;
  if (night.achievedHours >= night.requiredHours) return w;
  let until: string;
  if (lr.limitCrossedAt !== undefined && lr.limitCrossedC === night.thresholdC) until = `about ${localTimeText(lr.limitCrossedAt)}`;
  else if (lr.limitCrossedAt === undefined && lr.worstAt === undefined) until = 'the next recharge';
  else return w;
  return { code: w.code, message: `Tonight the ${roomName} stays at or below ${formatTemp(night.thresholdC, unit)} until ${until}, then it warms up.`.slice(0, 300) };
}

/** The plan's warnings: the night warning aligned with a last resort, and "no heat danger" never next to it (#285 review). */
export function warningsOf(chosen: Attempt, safest: LastResort | undefined, roomName: string, unit: TempUnit): PlanWarning[] {
  const night = chosen.verdict.nightRecovery;
  const own = safest === undefined ? chosen.verdict.warnings : chosen.verdict.warnings.filter((w) => w.code !== 'humid_air');
  return [...own.map((w) => alignedNightWarning(w, safest?.lastResort, night, roomName, unit)), ...(safest === undefined ? [] : [safest.warning])];
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
  const horizonMs = horizonOf(deps, guardInput, atMs);
  const cycleEndMs = horizonMs;
  const paced =
    cycle === undefined
      ? base
      : base.flatMap((s) => (s.roomId === preferences.safeRoomId && s.hvacMode !== 'off' ? dutyCycle(s, { ...cycle, fromMs: atMs, toMs: cycleEndMs }) : [s]));
  const nightly = season === 'cooling' && nightCooling ? withNightCooling(paced, deps, guardInput, atMs, horizonMs) : paced;
  // A plan the model proposed is checked exactly as it is; the planner's own plans follow the humidity.
  const finish = (steps: readonly PlanStep[]) => {
    const humid = season === 'cooling' && !exact ? withHumidityControl(steps, deps, guardInput, horizonMs) : [...steps];
    const untargeted: CandidatePlan = { horizonAt: new Date(horizonMs).toISOString(), steps: humid, ladder };
    const context = buildContext({ ...guardInput, plan: untargeted });
    // Each target is the lowest SOC the projection expects until the next target (see withTargets).
    const socMin = (fromMs: number, toMs: number) => {
      const socs = context.points.filter((p) => p.ms >= fromMs && p.ms < toMs).map((p) => p.socPct);
      return socs.length === 0 ? (context.points.at(-1)?.socPct ?? snapshot.batterySocPct) : Math.min(...socs);
    };
    const targeted = withTargets(humid, { socMin, fromMs: atMs, toMs: context.horizonMs, safeRoomId: preferences.safeRoomId, config: deps.config.planner });
    const candidate: CandidatePlan = { horizonAt: new Date(context.horizonMs).toISOString(), steps: targeted, ladder };
    return { candidate, context, verdict: runGuard({ ...guardInput, plan: candidate }) };
  };
  const plain = finish(nightly);
  // The solar surplus (#203): cooling, on grid, the planner's own plans only. The guard checks the whole plan
  // with it; if it refuses, the plan without it stands.
  const surplus = season === 'cooling' && !exact && snapshot.gridAvailable ? withSurplus(nightly, deps, guardInput, rung, plain.context, horizonMs) : undefined;
  if (surplus !== undefined) {
    const used = finish(surplus.steps);
    const keptKWh = Math.round(((exportWh(plain.context) - exportWh(used.context)) / 1000) * 10) / 10;
    if (used.verdict.ok && keptKWh > 0) {
      return { candidate: used.candidate, verdict: used.verdict, guardInput, surplus: { ...surplus.info, keptKWh } };
    }
    if (!used.verdict.ok) {
      const refused = used.verdict.guarantees.filter((g) => !g.ok).map((g) => g.id);
      return { candidate: plain.candidate, verdict: plain.verdict, guardInput, surplusRefused: refused };
    }
  }
  return { candidate: plain.candidate, verdict: plain.verdict, guardInput };
}

/** Energy the projection sends to the grid, in Wh. */
function exportWh(context: GuardContext): number {
  const stepH = context.input.config.projection.stepMinutes / 60;
  return context.points.reduce((wh, p) => wh + p.flows.gridExportW * stepH, 0);
}

/**
 * The solar surplus at home instead of on the grid (#203, owner decisions of 4/10): where the projection of the
 * plan exports, the safe room first, then the rooms occupied now or slept in tonight, the hottest above target
 * first, are cooled a little below comfort for that window, while the mean export covers their units' nominal
 * input. Never
 * colder than the household asked: comfort minus the configured offset (less in the safe room with an elderly
 * person), never under the heating minimum plus one. After the window each room goes back to its setting.
 */
function withSurplus(
  steps: readonly PlanStep[],
  deps: ComfortPlanDeps,
  guardInput: GuardInput,
  rung: LevelStep,
  context: GuardContext,
  horizonMs: number,
): { steps: PlanStep[]; info: Omit<NonNullable<Plan['surplus']>, 'keptKWh'> } | undefined {
  const { profile, preferences, snapshot } = guardInput;
  const cfg = deps.config.planner.surplus;
  const stepMs = deps.guard.projection.stepMinutes * 60_000;
  const window = surplusWindow(context.points, { minExportW: cfg.minExportW, stepMs, minSocPct: cfg.socFullPct });
  if (window === undefined) return undefined;
  const night = nextNightWindow(window.fromMs, horizonMs, profile.location.tz, deps.guard.nightRecovery);
  const tonight = night !== undefined && night.startMs >= window.toMs;
  const byPriority = [...profile.rooms].sort((a, b) => rank(preferences.roomPriority, a.id) - rank(preferences.roomPriority, b.id));
  const cooling = byPriority.filter((r) => r.hvacUnits.some((u) => u.modes.includes('cool')));
  const order = orderSurplusRooms(
    cooling.map((r) => {
      const now = snapshot.rooms.find((x) => x.id === r.id);
      return { id: r.id, tempC: now?.tempC, occupied: (now?.occupants.length ?? 0) > 0, isSafe: r.id === preferences.safeRoomId, sleptIn: r.sleptIn ?? false };
    }),
    { comfortC: preferences.comfortC.cooling, tonight },
  );
  // A unit cooling a room down draws about its nominal input; the guard then checks the inverter at the real draw.
  const demandW = (id: string) => profile.rooms.find((r) => r.id === id)?.hvacUnits.reduce((w, u) => w + u.inputKw.nominal * 1000, 0) ?? 0;
  // The person at risk first: if the safe room does not fit, nobody gets the surplus (#226 review).
  if (order[0]?.reason === 'safe_room' && demandW(order[0].roomId) > window.meanExportW) return undefined;
  let drawW = 0;
  const chosen = order.filter((r) => {
    if (drawW + demandW(r.roomId) > window.meanExportW) return false;
    drawW += demandW(r.roomId);
    return true;
  });
  if (chosen.length === 0) return undefined;

  const setpointOf = (roomId: string) => {
    const offset = roomId === preferences.safeRoomId && guardInput.nightRecoveryMode === 'elderly' ? cfg.elderlyOffsetK : cfg.offsetK;
    return celsius(Math.round(Math.max(preferences.comfortC.cooling - offset, preferences.safety.heating.minC + 1) * 10) / 10);
  };
  const from = new Date(window.fromMs).toISOString();
  const to = new Date(window.toMs).toISOString();
  const ids = new Set(chosen.map((r) => r.roomId));
  const inWindow = (st: PlanStep) => ids.has(st.roomId) && Date.parse(st.ts) >= window.fromMs && Date.parse(st.ts) < window.toMs;
  const added = chosen.flatMap((r): PlanStep[] => {
    const own = steps.filter((st) => st.roomId === r.roomId).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const before = own.filter((st) => Date.parse(st.ts) <= window.fromMs).at(-1);
    const after = own.filter((st) => Date.parse(st.ts) <= window.toMs).at(-1);
    const cool: PlanStep = { ts: from, roomId: r.roomId, hvacMode: 'cool', setpointC: setpointOf(r.roomId), fanOn: before?.fanOn ?? false, level: before?.level ?? rung.level, batteryTargetSocPct: pct(0) };
    const back: PlanStep = after !== undefined ? { ...after, ts: to } : { ...cool, ts: to, hvacMode: 'off', fanOn: false };
    const resumes = own.some((st) => Date.parse(st.ts) === window.toMs);
    return window.toMs < horizonMs && !resumes ? [cool, back] : [cool];
  });
  // In time order, and the person's room priority at the same time: the text and the manual steps keep their order.
  const ordered = [...steps.filter((st) => !inWindow(st)), ...added].sort(
    (a, b) => Date.parse(a.ts) - Date.parse(b.ts) || rank(preferences.roomPriority, a.roomId) - rank(preferences.roomPriority, b.roomId),
  );
  return {
    steps: ordered,
    info: {
      from: localIso(window.fromMs, profile.location.tz),
      to: localIso(window.toMs, profile.location.tz),
      rooms: chosen.map((r) => ({ roomId: r.roomId, setpointC: setpointOf(r.roomId), reason: r.reason, aboveTargetK: r.aboveTargetK })),
      // What aboveTargetK is measured from (orderSurplusRooms above): the card and the voice say it.
      comfortC: preferences.comfortC.cooling,
    },
  };
}

const rank = (order: readonly string[], id: string) => {
  const i = order.indexOf(id);
  return i < 0 ? order.length : i;
};

/** The planner's own search, without the model's overrides: the first plan that holds every guarantee. */
function firstPassing(deps: ComfortPlanDeps, guardInput: GuardInput, ladder: LevelStep[]): Attempt | undefined {
  for (let i = 0; i < ladder.length; i++) {
    const rung = ladder[i];
    if (rung === undefined) continue;
    const withNight = tryRung(deps, guardInput, ladder.slice(i), rung, false, undefined, undefined, true);
    if (withNight.verdict.ok) return withNight;
    const plain = tryRung(deps, guardInput, ladder.slice(i), rung, false);
    if (plain.verdict.ok) return plain;
  }
  const essential = ladder.length - 1;
  const rung = ladder[essential];
  if (rung === undefined) return undefined;
  for (const cycle of deps.config.planner.dutyCycles) {
    // With night cooling first, then without it, as the planner's own search does.
    const withNight = tryRung(deps, guardInput, ladder.slice(essential), rung, false, undefined, cycle, true);
    if (withNight.verdict.ok) return withNight;
    const plain = tryRung(deps, guardInput, ladder.slice(essential), rung, false, undefined, cycle);
    if (plain.verdict.ok) return plain;
  }
  return undefined;
}

/** Until the next recharge the forecast shows, else as far as the weather is known. */
function horizonOf(deps: ComfortPlanDeps, guardInput: GuardInput, atMs: number): number {
  const forecastEndMs = Math.max(atMs, ...guardInput.forecast.hourly.map((h) => Date.parse(h.ts) + 3_600_000));
  const recharge = darkWindow({
    forecast: guardInput.forecast,
    fromMs: atMs,
    pvPeakW: guardInput.profile.pvPeakW,
    lossRatio: deps.model.pv.lossRatio,
    essentialLoadW: deps.guard.reserve.essentialLoadW,
  });
  return recharge?.toMs ?? forecastEndMs;
}

/**
 * The hold of the safe room as a plan (#24, decision A): the guard's holdSafeRoom (pre-cooled toward the night
 * limit, dry or cool by humidity) until the horizon, as plan steps. The safe room at essential with the hold's
 * mode and setpoint at every change; every other room with a unit off. Battery targets from the projection, as
 * for any candidate, and the guard checks it like any plan: the hard limits stay hard. None when there is no hold.
 */
function holdAttempts(deps: ComfortPlanDeps, guardInput: GuardInput, onFail: (error: ErrorEnvelope) => void): Attempt[] {
  const { snapshot, profile, preferences, season, plan } = guardInput;
  const atMs = Date.parse(snapshot.ts);
  const horizonMs = horizonOf(deps, guardInput, atMs);
  const dischargeFloorPct = snapshot.gridAvailable ? reserveOf(guardInput).reserveFloorSocPct : pct(profile.battery.minSocHwPct);
  const held = holdSafeRoom(guardInput, { toMs: horizonMs, dischargeFloorPct, humidityBand: deps.config.planner.humidityBand, marginK: deps.config.planner.essentialMarginK });
  if (!held.ok) {
    onFail(held.error);
    return [];
  }
  // A safe-room-only essential plan pre-authorizes no other step: its ladder is essential alone.
  const ladder = plan.ladder.slice(-1);
  const safeId = preferences.safeRoomId;
  const ts = (ms: number) => new Date(ms).toISOString();
  const base = { fanOn: false, level: 'essential' as const, batteryTargetSocPct: snapshot.batterySocPct };
  const comfortC = season === 'heating' ? preferences.comfortC.heating : preferences.comfortC.cooling;
  const off = profile.rooms.filter((r) => r.id !== safeId && r.hvacUnits.length > 0).map((r): PlanStep => ({ ...base, ts: ts(atMs), roomId: r.id, hvacMode: 'off', setpointC: comfortC }));
  const safe: PlanStep[] = [];
  const stepMs = deps.guard.projection.stepMinutes * 60_000;
  let previous: string | undefined;
  for (let ms = atMs; ms < horizonMs; ms += stepMs) {
    const hvac = held.value.controlsAt(ms).find((c) => c.id === safeId)?.hvac;
    if (hvac === undefined) continue;
    const key = `${hvac.mode}|${String(hvac.setpointC)}`;
    if (key === previous) continue;
    previous = key;
    safe.push({ ...base, ts: ts(ms), roomId: safeId, hvacMode: hvac.mode, setpointC: hvac.setpointC });
  }
  if (safe.length === 0) return [];
  const steps0 = [...off, ...safe];
  const context = buildContext({ ...guardInput, plan: { horizonAt: ts(horizonMs), steps: steps0, ladder } });
  const socMin = (fromMs: number, toMs: number) => {
    const socs = context.points.filter((p) => p.ms >= fromMs && p.ms < toMs).map((p) => p.socPct);
    return socs.length === 0 ? (context.points.at(-1)?.socPct ?? snapshot.batterySocPct) : Math.min(...socs);
  };
  const steps = withTargets(steps0, { socMin, fromMs: atMs, toMs: context.horizonMs, safeRoomId: safeId, config: deps.config.planner });
  const candidate: CandidatePlan = { horizonAt: ts(context.horizonMs), steps, ladder };
  return [{ candidate, verdict: runGuard({ ...guardInput, plan: candidate }), guardInput }];
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
