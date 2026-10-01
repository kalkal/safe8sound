import type { Season } from '@cold-reserve/contracts';
import type { ProjectionPoint } from '@cold-reserve/core';
import { UNSERVED_TOLERANCE_W } from './context.js';

// Until when the safe room stays safe along a projection: the first point where the battery leaves load
// unserved, or where, after the grace period, the room leaves the limits safe_room_comfort checks (the
// cooling maximum, the heating minimum, the humidity band). Used for a last-resort plan: "safe until HH:MM".

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
    safety: { cooling: { maxC: number }; heating: { minC: number }; humidity: { minPct: number; maxPct: number } };
    /** Whether the plan dries the safe room at an instant: only then is air under the minimum its doing (#107). */
    driesAt?: (ms: number) => boolean;
  },
): { ms: number; limitedBy: SafeLimit } | undefined {
  const fromMs = opts.nowMs + opts.graceMinutes * MINUTE_MS;
  const { cooling, heating, humidity } = opts.safety;
  for (const p of points) {
    if (p.flows.unservedLoadW > UNSERVED_TOLERANCE_W) return { ms: p.ms, limitedBy: 'battery' };
    if (p.ms < fromMs) continue;
    const room = p.rooms.find((r) => r.id === opts.roomId);
    if (room === undefined) continue;
    const tooHot = opts.season !== 'heating' && room.tempC > cooling.maxC + EPS;
    const tooCold = opts.season !== 'cooling' && room.tempC < heating.minC - EPS;
    if (tooHot || tooCold) return { ms: p.ms, limitedBy: 'temperature' };
    const tooDry = room.humidityPct < humidity.minPct - EPS && (opts.driesAt?.(p.ms) ?? false);
    if (room.humidityPct > humidity.maxPct + EPS || tooDry) return { ms: p.ms, limitedBy: 'humidity' };
  }
  return undefined;
}
