import { celsius, effectiveHeatSafety, err, ok, toolError, type ErrorEnvelope, type HvacMode, type Pct, type Result } from '@cold-reserve/contracts';
import { humidityBandWithin, nextHumidityMode, nightMetrics, type HumidityBandConfig, type HumidityMode, type ProjectionPoint, type RoomControl } from '@cold-reserve/core';
import { projectFrom, type GuardInput } from './context.js';
import { heatDanger } from './heat-danger.js';
import { nightCoolingLimit, safeUntil, type SafeLimit } from './safe-until.js';

// One physics for "how long can the safe room hold" (#160, #24): the last resort and storm mode's safe hours
// read the same projection, and the last resort IS this hold (#24, decision A). When cooling, the safe room's
// split aims at the strictest limit it will face within the pre-cooling lead (the night-recovery threshold from
// the evening), or at the limit in force when that stays safe longer; dry or cool by its humidity with the
// planner's rule; every other room is off. When heating it holds the minimum plus the margin. With the grid down
// and a hold that ends before the horizon, it keeps the variant with the most night hours under the threshold
// (holdSafeRoom below).
// A room without a humidity reading starts from the indoorEquilibriumRh estimate (projectFrom), like the guard.

/** What sets the safe room's limit at an instant, for the words that name it. */
export type SafeRoomLimitKind = 'maximum' | 'night' | 'older_person_cap' | 'heat_index_cap' | 'minimum';

type LimitInput = Pick<GuardInput, 'preferences' | 'profile' | 'config' | 'season' | 'nightRecoveryMode'>;

/**
 * The safe room's temperature limit at an instant and what sets it: when cooling, the lowest of the maximum, the
 * night limit in the night window, and the caps the person set stricter (#266 review: the older-person cap with an
 * older person, the heat-index cap as an air target for everyone), so the hold, its safe hours and the last resort
 * never aim the air above a cap. In humid air the heat index can pass its cap below that air target: the guard and
 * safe-until still refuse or end the hours there, the hold just does not aim lower for it. With the default caps
 * (31 °C, 32.2 °C) nothing changes. When heating, the minimum.
 */
export function safeRoomLimitKindAt(input: LimitInput): (ms: number) => { limitC: number; kind: SafeRoomLimitKind } {
  const { preferences, profile, config, season, nightRecoveryMode } = input;
  if (season === 'heating') return () => ({ limitC: preferences.safety.heating.minC, kind: 'minimum' });
  const maxC = preferences.safety.cooling.maxC;
  const night = nightCoolingLimit({ maxC, tz: profile.location.tz, night: config.nightRecovery, mode: nightRecoveryMode });
  const heat = effectiveHeatSafety(preferences.safety);
  // In this order on a tie, so the familiar words win: the maximum, then the night limit.
  const caps: { limitC: number; kind: SafeRoomLimitKind }[] = [
    ...(nightRecoveryMode === 'elderly' ? [{ limitC: heat.elderlyCapC, kind: 'older_person_cap' as const }] : []),
    { limitC: heat.heatIndexCapC, kind: 'heat_index_cap' },
  ];
  return (ms) => {
    const nightC = night(ms);
    let best: { limitC: number; kind: SafeRoomLimitKind } = nightC < maxC ? { limitC: nightC, kind: 'night' } : { limitC: maxC, kind: 'maximum' };
    for (const cap of caps) if (cap.limitC < best.limitC) best = cap;
    return best;
  };
}

/** The safe room's temperature limit at an instant (safeRoomLimitKindAt without the words). */
export function safeRoomLimitAt(input: LimitInput): (ms: number) => number {
  const at = safeRoomLimitKindAt(input);
  return (ms) => at(ms).limitC;
}

export interface HoldSafeRoomOptions {
  readonly toMs: number;
  readonly dischargeFloorPct: Pct;
  /** The planner's humidity band config: the hold narrows it inside the person's limits (humidityBandWithin). */
  readonly humidityBand: HumidityBandConfig;
  /** How far inside the limit the split is set, in kelvin. */
  readonly marginK: number;
}

/** What the hold needs: the guard's input without a plan (storm mode has none). */
export type HoldSafeRoomInput = Omit<GuardInput, 'plan'>;

export interface HeldSafeRoom {
  readonly points: ProjectionPoint[];
  /** Undefined when the room stays safe through the projection. */
  readonly safeUntil: { readonly ms: number; readonly limitedBy: SafeLimit } | undefined;
  /** What the hold commanded at a projection step (the latest step at or before `ms`). */
  readonly controlsAt: (ms: number) => readonly RoomControl[];
  /** Whether the step before `ms` was drying: only then is air under the minimum the hold's doing (#107). */
  readonly driesAt: (ms: number) => boolean;
}

/**
 * The modes the hold may use, as the planner does (withHumidityControl): it switches dry and cool by humidity
 * only when the safe room's unit has both; otherwise it keeps the one it has (cool first, like the night
 * reference). Outside the heating season it cools, as the planner does for any goal but heat.
 */
function holdModes(input: HoldSafeRoomInput): { readonly switches: boolean; readonly fixed: HvacMode | undefined } {
  const modes = input.profile.rooms.find((r) => r.id === input.preferences.safeRoomId)?.hvacUnits.flatMap((u) => u.modes) ?? [];
  if (input.season === 'heating') return { switches: false, fixed: modes.includes('heat') ? 'heat' : undefined };
  return { switches: modes.includes('dry') && modes.includes('cool'), fixed: modes.includes('cool') ? 'cool' : modes.includes('dry') ? 'dry' : undefined };
}

export function holdSafeRoom(input: HoldSafeRoomInput, opts: HoldSafeRoomOptions): Result<HeldSafeRoom, ErrorEnvelope> {
  const roomId = input.preferences.safeRoomId;
  if (!input.snapshot.rooms.some((r) => r.id === roomId)) {
    // Never "safe for the whole horizon" for a room nobody reads.
    return err(toolError('unknown_room', `No reading from the safe room ${roomId}.`, { details: { field: 'safeRoomId', roomId } }));
  }
  if (!input.profile.rooms.some((r) => r.id === roomId)) {
    // The projection drops a room the profile does not describe: no breach would ever be found.
    return err(toolError('unknown_room', `The safe room ${roomId} is not in the home profile.`, { details: { field: 'safeRoomId', roomId } }));
  }
  const leadMs = input.config.safeRoom.preCoolLeadMinutes * 60_000;
  const plain = holdWith(input, opts, { leadMs: 0, dry: 'band' });
  // The lead is for cooling only: the heating minimum does not change at night.
  if (input.season === 'heating') return ok(plain);
  // Pre-cooling (#24) costs battery: with too little of it the room can stay safe longer by holding only the
  // limit in force. Like the last resort, the hold keeps whichever stays safe longer (plain on a tie).
  const preCooled = leadMs === 0 ? plain : holdWith(input, opts, { leadMs, dry: 'band' });
  const endOf = (h: HeldSafeRoom) => h.safeUntil?.ms ?? Number.POSITIVE_INFINITY;
  const first = endOf(preCooled) > endOf(plain) ? preCooled : plain;
  // With the grid down and a hold that ends before the horizon (the battery runs out first, or pre-cooling would
  // run it out so the room meets the night limit too warm), the hold is the best use of what is left. Two things
  // then cost night hours: the dry mode, which draws a fixed share of the nominal input whatever the room needs,
  // and a split held half a degree under the limit, which leaves the room little inertia once the battery is
  // empty. So the hold also tries cooling only (dry only while heat and humidity together are a danger), at its
  // usual aim and down to the comfort setpoint while there is energy, with and without the lead, and keeps the one
  // whose room leaves its limits latest, then the most night hours under the threshold (bestHold). The battery
  // floor and the EPS stay in the projection.
  // plan_comfort with the grid still up keeps `first` while the storm card (grid forced down) may take a variant:
  // no disagreement today, since with the grid up the plan holds and names no safe-until.
  if (input.snapshot.gridAvailable || first.safeUntil === undefined) return ok(first);
  const comfortC = input.preferences.comfortC.cooling;
  const leads = leadMs === 0 ? [0] : [0, leadMs];
  const alternatives = [
    ...leads.map((lead) => holdWith(input, opts, { leadMs: lead, dry: 'heat_index' })),
    ...leads.map((lead) => holdWith(input, opts, { leadMs: lead, dry: 'heat_index', comfortC })),
  ];
  return ok(bestHold(input, first, alternatives));
}

const SCORE_EPS = 1e-9;

/**
 * When the room really leaves its limits along a hold: where its safe hours end on the room (too hot, feels too
 * hot, dried too far), that end; where they end on the battery, the first point from there on whose room, rounded
 * as it is said, is past the limit in force (the room holds it a while by inertia, the "until about" the plan
 * says, #272); never inside the projection, infinity.
 */
export function leavesLimitsMs(h: HeldSafeRoom, roomId: string, limitAt: (ms: number) => number): number {
  const end = h.safeUntil;
  if (end === undefined) return Number.POSITIVE_INFINITY;
  if (end.limitedBy !== 'battery') return end.ms;
  const past = h.points.find((p) => {
    if (p.ms < end.ms) return false;
    const tempC = p.rooms.find((r) => r.id === roomId)?.tempC;
    return tempC !== undefined && Math.round(tempC * 10) / 10 > limitAt(p.ms);
  });
  return past?.ms ?? Number.POSITIVE_INFINITY;
}

/**
 * Among holds with the grid down, the one whose room leaves its limits latest (leavesLimitsMs): a variant that
 * ends earlier on the heat never wins, and with more battery that time never comes earlier (each variant's only
 * moves later with more charge). A variant may end its safe hours earlier only because the battery runs out, when
 * the room it leaves behind stays inside its limits longer. On a tie the most hours of the first night window at
 * or under the night threshold, then the later end of the safe hours, then the earlier in the list.
 */
export function bestHold(input: HoldSafeRoomInput, first: HeldSafeRoom, others: readonly HeldSafeRoom[]): HeldSafeRoom {
  const roomId = input.preferences.safeRoomId;
  const night = input.config.nightRecovery;
  const thresholdC = Math.min(input.preferences.safety.cooling.maxC, night.thresholdC[input.nightRecoveryMode]);
  const limitAt = safeRoomLimitAt(input);
  const score = (h: HeldSafeRoom) => ({
    leavesMs: leavesLimitsMs(h, roomId, limitAt),
    hours: nightMetrics(h.points, { roomId, tz: input.profile.location.tz, stepMinutes: input.config.projection.stepMinutes, thresholdC, config: night })?.achievedHours ?? 0,
    endMs: h.safeUntil?.ms ?? Number.POSITIVE_INFINITY,
  });
  let best = first;
  let bestScore = score(best);
  for (const h of others) {
    const s = score(h);
    const sameLeave = s.leavesMs === bestScore.leavesMs;
    const sameHours = Math.abs(s.hours - bestScore.hours) <= SCORE_EPS;
    const better = s.leavesMs > bestScore.leavesMs || (sameLeave && (s.hours > bestScore.hours + SCORE_EPS || (sameHours && s.endMs > bestScore.endMs)));
    if (better) {
      best = h;
      bestScore = s;
    }
  }
  return best;
}

/**
 * How a hold aims: `leadMs` ahead for the strictest limit (0: the limit in force); `dry` the rule for the dry
 * mode, the planner's humidity band, or only while the heat index makes the room dangerous; `comfortC` a lower
 * aim, never above the limit's.
 */
interface HoldVariant {
  readonly leadMs: number;
  readonly dry: 'band' | 'heat_index';
  readonly comfortC?: number;
}

/**
 * One hold: the safe room's split aims at the strictest limit it will face within `leadMs` (0: the limit in
 * force), so with a lead the room is already inside the night limit when the night starts, as a plan that
 * pre-cools would have it.
 */
function holdWith(input: HoldSafeRoomInput, opts: HoldSafeRoomOptions, variant: HoldVariant): HeldSafeRoom {
  const { leadMs } = variant;
  const roomId = input.preferences.safeRoomId;
  const limitAt = safeRoomLimitAt(input);
  const stepMs = input.config.projection.stepMinutes * 60_000;
  const heating = input.season === 'heating';
  const targetAt = (ms: number): number => {
    let target = limitAt(ms);
    for (let t = ms + stepMs; t <= ms + leadMs; t += stepMs) target = Math.min(target, limitAt(t));
    return target;
  };
  const band = humidityBandWithin(opts.humidityBand, input.preferences.safety.humidity);
  const { switches, fixed } = holdModes(input);
  const commanded = new Map<number, { controls: readonly RoomControl[]; mode?: HvacMode }>();
  let humidityMode: HumidityMode | undefined;
  const heat = effectiveHeatSafety(input.preferences.safety);
  const caps = { heatIndexC: heat.heatIndexCapC, elderlyC: heat.elderlyCapC };
  const elderly = input.nightRecoveryMode === 'elderly';
  // Heat and humidity together dangerous (the NWS heat index over the limit or its cap): only then does the
  // 'heat_index' rule dry; humid air alone is a warning, never a reason to spend the battery on drying.
  const humidHeat = (r: { tempC: number; humidityPct: number }, ms: number): boolean => {
    const rule = heatDanger(r, { limitC: limitAt(ms), elderly, caps })?.rule;
    return rule === 'heat_index' || rule === 'extreme_caution';
  };

  const controlAt = (ms: number, rooms: readonly { id: string; tempC: number; humidityPct: number }[]): readonly RoomControl[] => {
    const known = commanded.get(ms);
    if (known !== undefined) return known.controls;
    const safe = rooms.find((r) => r.id === roomId);
    if (switches && safe !== undefined) humidityMode = variant.dry === 'band' ? nextHumidityMode(humidityMode, safe.humidityPct, band) : humidHeat(safe, ms) ? 'dry' : 'cool';
    const mode = switches ? (humidityMode ?? 'cool') : fixed;
    const aimC = heating ? targetAt(ms) + opts.marginK : targetAt(ms) - opts.marginK;
    const setpointC = celsius(!heating && variant.comfortC !== undefined ? Math.min(aimC, variant.comfortC) : aimC);
    const controls = rooms.map((r): RoomControl => (r.id === roomId && mode !== undefined ? { id: r.id, hvac: { mode, setpointC }, fanOn: false } : { id: r.id, fanOn: false }));
    commanded.set(ms, { controls, ...(mode === undefined ? {} : { mode }) });
    return controls;
  };

  // The projection ignores the plan: the hold's own control drives every room.
  const points = projectFrom({ ...input, plan: { horizonAt: input.snapshot.ts, steps: [], ladder: [] } }, controlAt, {
    toMs: opts.toMs,
    dischargeFloorPct: opts.dischargeFloorPct,
  });
  const driesAt = (ms: number) => commanded.get(ms - stepMs)?.mode === 'dry';
  const controlsAt = (ms: number) => {
    let latest: number | undefined;
    for (const at of commanded.keys()) if (at <= ms && (latest === undefined || at > latest)) latest = at;
    return latest === undefined ? [] : (commanded.get(latest)?.controls ?? []);
  };
  const end = safeUntil(points, {
    nowMs: Date.parse(input.snapshot.ts),
    graceMinutes: input.config.safeRoom.graceMinutes,
    roomId,
    season: input.season,
    safety: input.preferences.safety,
    coolingMaxAt: limitAt,
    driesAt,
    elderly: input.nightRecoveryMode === 'elderly',
  });
  return { points, safeUntil: end, controlsAt, driesAt };
}
