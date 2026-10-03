import { celsius, err, ok, toolError, type ErrorEnvelope, type HvacMode, type Pct, type Result } from '@cold-reserve/contracts';
import { humidityBandWithin, nextHumidityMode, type HumidityBandConfig, type HumidityMode, type ProjectionPoint, type RoomControl } from '@cold-reserve/core';
import { projectFrom, type GuardInput } from './context.js';
import { nightCoolingLimit, safeUntil, type SafeLimit } from './safe-until.js';

// One physics for "how long can the safe room hold" (#160, #24): the last resort and storm mode's safe hours
// read the same projection, and the last resort IS this hold (#24, decision A). When cooling, the safe room's
// split aims at the strictest limit it will face within the pre-cooling lead (the night-recovery threshold from
// the evening), or at the limit in force when that stays safe longer; dry or cool by its humidity with the
// planner's rule; every other room is off. When heating it holds the minimum plus the margin.
// A room without a humidity reading starts from the indoorEquilibriumRh estimate (projectFrom), like the guard.

/** The safe room's temperature limit at an instant: the cooling maximum (lowered at night) or the heating minimum. */
export function safeRoomLimitAt(input: Pick<GuardInput, 'preferences' | 'profile' | 'config' | 'season' | 'nightRecoveryMode'>): (ms: number) => number {
  const { preferences, profile, config, season, nightRecoveryMode } = input;
  if (season === 'heating') return () => preferences.safety.heating.minC;
  return nightCoolingLimit({ maxC: preferences.safety.cooling.maxC, tz: profile.location.tz, night: config.nightRecovery, mode: nightRecoveryMode });
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
  const plain = holdWith(input, opts, 0);
  // The lead is for cooling only: the heating minimum does not change at night.
  if (leadMs === 0 || input.season === 'heating') return ok(plain);
  // Pre-cooling (#24) costs battery: with too little of it the room can stay safe longer by holding only the
  // limit in force. Like the last resort, the hold keeps whichever stays safe longer (plain on a tie).
  const preCooled = holdWith(input, opts, leadMs);
  const endOf = (h: HeldSafeRoom) => h.safeUntil?.ms ?? Number.POSITIVE_INFINITY;
  return ok(endOf(preCooled) > endOf(plain) ? preCooled : plain);
}

/**
 * One hold: the safe room's split aims at the strictest limit it will face within `leadMs` (0: the limit in
 * force), so with a lead the room is already inside the night limit when the night starts, as a plan that
 * pre-cools would have it.
 */
function holdWith(input: HoldSafeRoomInput, opts: HoldSafeRoomOptions, leadMs: number): HeldSafeRoom {
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

  const controlAt = (ms: number, rooms: readonly { id: string; humidityPct: number }[]): readonly RoomControl[] => {
    const known = commanded.get(ms);
    if (known !== undefined) return known.controls;
    const safe = rooms.find((r) => r.id === roomId);
    if (switches && safe !== undefined) humidityMode = nextHumidityMode(humidityMode, safe.humidityPct, band);
    const mode = switches ? (humidityMode ?? 'cool') : fixed;
    const setpointC = celsius(heating ? targetAt(ms) + opts.marginK : targetAt(ms) - opts.marginK);
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
  });
  return { points, safeUntil: end, controlsAt, driesAt };
}
