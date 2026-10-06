import type { NightRecoveryMode, Season } from '@cold-reserve/contracts';
import { inNightWindow, type NightWindowHours, type ProjectionPoint } from '@cold-reserve/core';
import { UNSERVED_TOLERANCE_W } from './context.js';
import { heatDanger } from './heat-danger.js';

// Until when the safe room stays safe along a projection: the first point where the battery leaves load
// unserved, or where, after the grace period, the room leaves the limits safe_room_comfort checks (heat danger
// against the cooling maximum, the heating minimum, the humidity minimum where the plan dries the room). Used for a last-resort plan: "safe until HH:MM".

const MINUTE_MS = 60_000;
const EPS = 1e-9;

export type SafeLimit = 'battery' | 'temperature' | 'humidity';

export function safeUntil(
  points: readonly ProjectionPoint[],
  opts: {
    nowMs: number;
    graceMinutes: number;
    roomId: string;
    season: Season;
    safety: { cooling: { maxC: number }; heating: { minC: number }; humidity: { minPct: number } };
    /** An older person in the safe room: the 31 °C cap applies (#248). */
    elderly?: boolean;
    /** Whether the plan dries the safe room at an instant: only then is air under the minimum its doing (#107). */
    driesAt?: (ms: number) => boolean;
    /** The cooling maximum in force at an instant (the night threshold lowers it, #160); `cooling.maxC` otherwise. */
    coolingMaxAt?: (ms: number) => number;
  },
): { ms: number; limitedBy: SafeLimit } | undefined {
  const fromMs = opts.nowMs + opts.graceMinutes * MINUTE_MS;
  const { cooling, heating, humidity } = opts.safety;
  for (const p of points) {
    if (p.flows.unservedLoadW > UNSERVED_TOLERANCE_W) return { ms: p.ms, limitedBy: 'battery' };
    if (p.ms < fromMs) continue;
    const room = p.rooms.find((r) => r.id === opts.roomId);
    if (room === undefined) continue;
    // Heat danger (#248): the air or the heat index above the limit in force, or a fixed cap. Humid air alone is not.
    const tooHot = opts.season !== 'heating' && heatDanger(room, { limitC: opts.coolingMaxAt?.(p.ms) ?? cooling.maxC, elderly: opts.elderly ?? false, eps: EPS }) !== undefined;
    const tooCold = opts.season !== 'cooling' && room.tempC < heating.minC - EPS;
    if (tooHot || tooCold) return { ms: p.ms, limitedBy: 'temperature' };
    if (room.humidityPct < humidity.minPct - EPS && (opts.driesAt?.(p.ms) ?? false)) return { ms: p.ms, limitedBy: 'humidity' };
  }
  return undefined;
}

/**
 * The cooling maximum of the safe room at an instant (#160): during the night window the night-recovery
 * threshold of the mode (26 °C, 24 °C with an elderly person) when it is lower than the safety maximum. The
 * health threshold at night cannot be overridden by a higher preference.
 */
export function nightCoolingLimit(opts: {
  maxC: number;
  tz: string;
  night: NightWindowHours & { thresholdC: Readonly<Record<NightRecoveryMode, number>> };
  mode: NightRecoveryMode;
}): (ms: number) => number {
  const nightC = Math.min(opts.maxC, opts.night.thresholdC[opts.mode]);
  return (ms) => (inNightWindow(ms, opts.tz, opts.night) ? nightC : opts.maxC);
}
