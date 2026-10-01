import {
  celsius,
  pct,
  type HomeProfile,
  type HvacMode,
  type Level,
  type LevelStep,
  type PlanStep,
  type Preferences,
  type Season,
} from '@cold-reserve/contracts';
import { allocateRooms } from './rooms.js';

// The planner builds candidates; the guard decides (plan §9.2). Pure and config-driven:
// - the ladder follows the table of plan §4bis (cooling; heating mirrors it);
// - a candidate for one rung sets every room of that rung, switching off in priority order the rooms whose
//   maximum input does not fit the power budget (inverter limit, safe room first);
// - battery targets come from the projection of the candidate itself, so the plan's trajectory is one the
//   physics can follow.

export type PlanGoal = 'cool' | 'heat' | 'dry' | 'auto';

export interface PlannerConfig {
  /** Setpoint offsets from the comfort setpoint, in K, towards saving (warmer when cooling). */
  readonly levelOffsetK: Readonly<Record<Exclude<Level, 'essential'>, number>>;
  /** Essential keeps the safe room this far inside its safety threshold. */
  readonly essentialMarginK: number;
  /** Above this relative humidity a level that prefers dry uses the dry mode. */
  readonly dryAboveRhPct: number;
  /** Battery targets every so many minutes. */
  readonly targetEveryMinutes: number;
  /** How the essential rung may run the unit part of the time when it cannot run all the time, most first. */
  readonly dutyCycles: readonly { readonly onMinutes: number; readonly periodMinutes: number }[];
  /** Dry or cool in the safe room: dry once the projected humidity rises above `dryOnPct`, cool again below `dryOffPct`. */
  readonly humidityBand: HumidityBandConfig;
}

export interface HumidityBandConfig {
  readonly dryOnPct: number;
  readonly dryOffPct: number;
  /** How far inside the person's humidity limits the band is kept. */
  readonly marginPct: number;
}

/**
 * The band the planner aims at, inside the person's humidity limits: the configured edges, narrowed to a
 * margin within the limits (a 40-50 % preference must not be aimed at with 45-55 %). Limits too close for a
 * band give a single point, their middle.
 */
export function humidityBandWithin(band: HumidityBandConfig, limits: { minPct: number; maxPct: number }): { dryOnPct: number; dryOffPct: number } {
  const dryOnPct = Math.min(band.dryOnPct, limits.maxPct - band.marginPct);
  const dryOffPct = Math.max(band.dryOffPct, limits.minPct + band.marginPct);
  if (dryOffPct <= dryOnPct) return { dryOnPct, dryOffPct };
  const middle = (limits.minPct + limits.maxPct) / 2;
  return { dryOnPct: middle, dryOffPct: middle };
}

export type HumidityMode = 'dry' | 'cool';

/**
 * Dry or cool for the safe room at the next step, from its humidity now, with hysteresis: cool turns to dry
 * once the humidity is above `dryOnPct`, dry turns back to cool once it is below `dryOffPct`. One mode for the
 * whole evening and night either over-humidifies (cool) or over-dries (dry); inside the band the mode never flips.
 */
export function nextHumidityMode(current: HumidityMode | undefined, rhPct: number, config: { dryOnPct: number; dryOffPct: number }): HumidityMode {
  if (current === 'dry') return rhPct < config.dryOffPct ? 'cool' : 'dry';
  return rhPct > config.dryOnPct ? 'dry' : 'cool';
}

/**
 * The season of a plan: an explicit goal decides; with `auto` the forecast does. Cooling when it gets
 * warmer than the cooling comfort (checked first: a hot afternoon matters more than a cool dawn),
 * heating when it gets colder than the heating comfort, neutral otherwise.
 */
export function seasonFor(goal: PlanGoal, hourly: readonly { tempOutC: number }[], preferences: Preferences): Season {
  if (goal === 'heat') return 'heating';
  if (goal !== 'auto') return 'cooling';
  if (hourly.some((h) => h.tempOutC >= preferences.comfortC.cooling)) return 'cooling';
  if (hourly.some((h) => h.tempOutC <= preferences.comfortC.heating)) return 'heating';
  return 'neutral';
}

const RUNGS: readonly Level[] = ['comfort', 'balanced', 'saver', 'essential'];

export function buildLadder(opts: {
  season: Season;
  goal: PlanGoal;
  profile: HomeProfile;
  preferences: Preferences;
  occupied: readonly string[];
  config: PlannerConfig;
}): LevelStep[] {
  const { preferences, config } = opts;
  const heating = opts.goal === 'heat' || (opts.goal === 'auto' && opts.season === 'heating');
  const sign = heating ? -1 : 1;
  const comfortC = heating ? preferences.comfortC.heating : preferences.comfortC.cooling;
  const essentialC = heating ? preferences.safety.heating.minC + config.essentialMarginK : preferences.safety.cooling.maxC - config.essentialMarginK;
  const main: HvacMode = heating ? 'heat' : 'cool';
  const served = ordered([preferences.safeRoomId, ...opts.occupied], preferences.roomPriority).filter((id) => opts.profile.rooms.some((r) => r.id === id));

  return RUNGS.map((level): LevelStep => {
    const saving = level !== 'comfort';
    const preferredModes: HvacMode[] = opts.goal === 'dry' ? ['dry'] : saving && !heating ? ['dry', main] : [main];
    return {
      level,
      setpointOffsetK: level === 'essential' ? round1(essentialC - comfortC) : sign * config.levelOffsetK[level] + 0,
      fansOn: saving,
      preferredModes,
      roomIds: level === 'essential' ? [preferences.safeRoomId] : served,
    };
  });
}

/** One step per room of the rung at `atMs`, without battery targets yet (see `withTargets`). */
export function candidateSteps(opts: {
  ladderStep: LevelStep;
  comfortC: number;
  atMs: number;
  profile: HomeProfile;
  priority: readonly string[];
  /** Power the rooms may draw together at their maximum input (inverter limit minus the base load). */
  budgetW: number;
  humidityByRoom: Readonly<Record<string, number>>;
  config: PlannerConfig;
  /** Overrides the rung's setpoint (the model proposed one). */
  setpointC?: number;
}): PlanStep[] {
  const { ladderStep: rung, profile } = opts;
  const rooms = rung.roomIds.flatMap((id) => profile.rooms.filter((r) => r.id === id));
  const fanW = (id: string) => (rung.fansOn ? (profile.rooms.find((r) => r.id === id)?.fans.reduce((w, f) => w + f.powerW, 0) ?? 0) : 0);
  const demands = rooms.map((r) => ({ roomId: r.id, demandW: r.hvacUnits.reduce((w, u) => w + u.inputKw.max * 1000, 0) + fanW(r.id) }));
  const service = allocateRooms({ demands, priority: opts.priority, budgetW: opts.budgetW });
  const setpointC = celsius(round1(opts.setpointC ?? opts.comfortC + rung.setpointOffsetK));
  const ts = new Date(opts.atMs).toISOString();

  return service.map(({ roomId, state }): PlanStep => {
    const room = profile.rooms.find((r) => r.id === roomId);
    const modes = room?.hvacUnits.flatMap((u) => u.modes) ?? [];
    const humid = (opts.humidityByRoom[roomId] ?? 0) > opts.config.dryAboveRhPct;
    const usable = rung.preferredModes.filter((m) => modes.includes(m) && (m !== 'dry' || humid || rung.preferredModes.length === 1));
    const mode: HvacMode = state === 'served' ? (usable[0] ?? 'off') : 'off';
    return {
      ts,
      roomId,
      hvacMode: mode,
      setpointC,
      fanOn: state === 'served' && fanW(roomId) > 0,
      level: rung.level,
      batteryTargetSocPct: pct(0),
    };
  });
}

/**
 * Stamps the battery targets. Every `targetEveryMinutes` without a safe-room step, the safe room repeats the
 * setting in force then, up to `toMs`. Each target is `socMin` over its interval: from its time to the
 * next target time (or `toMs`), i.e. the lowest SOC the plan expects before the next target, so the
 * trajectory is one the battery can follow and consecutive targets never imply an impossible rate.
 */
export function withTargets(
  steps: readonly PlanStep[],
  opts: { socMin: (fromMs: number, toMs: number) => number; fromMs: number; toMs: number; safeRoomId: string; config: PlannerConfig },
): PlanStep[] {
  const safe = steps.filter((s) => s.roomId === opts.safeRoomId).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const every = opts.config.targetEveryMinutes * 60_000;
  const repeats: PlanStep[] = [];
  for (let ms = opts.fromMs + every; ms < opts.toMs; ms += every) {
    if (safe.some((s) => Date.parse(s.ts) === ms)) continue;
    const inForce = safe.filter((s) => Date.parse(s.ts) <= ms).at(-1);
    if (inForce !== undefined) repeats.push({ ...inForce, ts: new Date(ms).toISOString() });
  }
  const all = [...steps, ...repeats];
  // The marks every interval carry the lowest SOC up to the next mark. A step between two marks (a pacing
  // cycle, a change of mode) is interpolated between theirs: a target of its own, the lowest SOC up to the next
  // step, would compare windows of different lengths and make the battery look many times faster than it is.
  const marks: number[] = [];
  for (let ms = opts.fromMs; ms < opts.toMs; ms += every) marks.push(ms);
  const markTarget = marks.map((ms, i) => opts.socMin(ms, marks[i + 1] ?? Math.max(opts.toMs, ms + every)));
  const targetAt = (ms: number): number => {
    const i = marks.findLastIndex((m) => m <= ms);
    const from = marks[i];
    const at = markTarget[i];
    if (from === undefined || at === undefined) return opts.socMin(ms, ms + every);
    if (from === ms) return at;
    const to = marks[i + 1];
    const then = markTarget[i + 1];
    if (to === undefined || then === undefined) return Math.min(at, opts.socMin(ms, Math.max(opts.toMs, from + every)));
    const interpolated = at + ((then - at) * (ms - from)) / (to - from);
    return Math.min(interpolated, opts.socMin(ms, to));
  };
  return all.map((s) => ({ ...s, batteryTargetSocPct: pct(targetAt(Date.parse(s.ts))) }));
}

/**
 * Pacing inside the hour: the unit runs for `onMinutes` at the start of every period and only the fan runs
 * for the rest, from `fromMs` to `toMs`. Dehumidifying part of the hour keeps the safe room dry for much
 * less energy than running all the time.
 */
export function dutyCycle(step: PlanStep, opts: { onMinutes: number; periodMinutes: number; fromMs: number; toMs: number }): PlanStep[] {
  if (opts.onMinutes >= opts.periodMinutes) return [step];
  const period = opts.periodMinutes * 60_000;
  const steps: PlanStep[] = [];
  for (let ms = opts.fromMs; ms < opts.toMs; ms += period) {
    steps.push({ ...step, ts: new Date(ms).toISOString() });
    const offMs = ms + opts.onMinutes * 60_000;
    if (offMs < opts.toMs) steps.push({ ...step, ts: new Date(offMs).toISOString(), hvacMode: 'fan_only', fanOn: true });
  }
  return steps;
}

const round1 = (x: number) => Math.round(x * 10) / 10 + 0;

function ordered(ids: readonly string[], priority: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  const rank = (id: string) => (priority.includes(id) ? priority.indexOf(id) : priority.length);
  return unique.map((id, i) => ({ id, i })).sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i).map((x) => x.id);
}
