import { celsius, err, ok, toolError, type ErrorEnvelope, type HvacMode, type Pct, type Result } from '@cold-reserve/contracts';
import { humidityBandWithin, nextHumidityMode, type HumidityBandConfig, type HumidityMode, type ProjectionPoint, type RoomControl } from '@cold-reserve/core';
import { projectFrom, type GuardInput } from './context.js';
import { nightCoolingLimit, safeUntil, type SafeLimit } from './safe-until.js';

// One physics for "how long can the safe room hold" (#160, #24): the last resort and storm mode's safe hours
// read the same projection. The safe room's split is held at the limit in force (at night the night-recovery
// threshold when lower), dry or cool by its humidity with the planner's rule; every other room is off.
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
  const limitAt = safeRoomLimitAt(input);
  const stepMs = input.config.projection.stepMinutes * 60_000;
  const heating = input.season === 'heating';
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
    const setpointC = celsius(heating ? limitAt(ms) + opts.marginK : limitAt(ms) - opts.marginK);
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
  return ok({ points, safeUntil: end, controlsAt, driesAt });
}
