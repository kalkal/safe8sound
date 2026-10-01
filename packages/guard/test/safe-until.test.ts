import { celsius, pct, watt } from '@cold-reserve/contracts';
import type { ProjectionPoint } from '@cold-reserve/core';
import { describe, expect, it } from 'vitest';
import { projectFrom } from '../src/context.js';
import { safeUntil } from '../src/safe-until.js';
import { H, MIN, T0, input } from './support.js';

// Until when the safe room stays safe along a projection: the battery serves the load, and after the grace
// period the room stays within its temperature and humidity limits (the same limits as safe_room_comfort).

const base = projectFrom(input(), () => [], { toMs: T0 + 12 * H, dischargeFloorPct: pct(10) });
const shaped = (room: (ms: number) => { tempC: number; rh: number }, unservedFromMs = Infinity): ProjectionPoint[] =>
  base.map((p) => ({
    ...p,
    rooms: p.rooms.map((r) => (r.id === 'bedroom-1' ? { ...r, tempC: celsius(room(p.ms).tempC), humidityPct: pct(room(p.ms).rh) } : r)),
    flows: { ...p.flows, unservedLoadW: watt(p.ms >= unservedFromMs ? 300 : 0) },
  }));
const opts = {
  nowMs: T0,
  graceMinutes: 60,
  roomId: 'bedroom-1',
  season: 'cooling' as const,
  safety: { cooling: { maxC: 27 }, heating: { minC: 18 }, humidity: { minPct: 40, maxPct: 60 } },
};
const fine = () => ({ tempC: 26, rh: 50 });

describe('safeUntil', () => {
  it('is undefined when the room stays safe through the projection', () => {
    expect(safeUntil(shaped(fine), opts)).toBeUndefined();
  });

  it('ends where the battery leaves load unserved', () => {
    expect(safeUntil(shaped(fine, T0 + 7 * H), opts)).toEqual({ ms: T0 + 7 * H, limitedBy: 'battery' });
  });

  it('ends where the room goes above its maximum, or out of its humidity band', () => {
    expect(safeUntil(shaped((ms) => ({ tempC: ms >= T0 + 5 * H ? 27.2 : 26, rh: 50 })), opts)).toEqual({ ms: T0 + 5 * H, limitedBy: 'temperature' });
    expect(safeUntil(shaped((ms) => ({ tempC: 26, rh: ms >= T0 + 4 * H ? 61 : 50 })), opts)).toEqual({ ms: T0 + 4 * H, limitedBy: 'humidity' });
    // Under the minimum only where the plan dries the room (#107): cooling cannot raise the humidity.
    expect(safeUntil(shaped((ms) => ({ tempC: 26, rh: ms >= T0 + 4 * H ? 39 : 50 })), { ...opts, driesAt: () => true })).toEqual({ ms: T0 + 4 * H, limitedBy: 'humidity' });
    expect(safeUntil(shaped((ms) => ({ tempC: 26, rh: ms >= T0 + 4 * H ? 39 : 50 })), opts)).toBeUndefined();
  });

  it('accepts the limits themselves', () => {
    expect(safeUntil(shaped(() => ({ tempC: 27, rh: 60 })), opts)).toBeUndefined();
    expect(safeUntil(shaped(() => ({ tempC: 27, rh: 40 })), opts)).toBeUndefined();
  });

  it('gives the room its grace period to get there, but not the battery', () => {
    expect(safeUntil(shaped((ms) => ({ tempC: ms < T0 + 55 * MIN ? 29 : 26, rh: 50 })), opts)).toBeUndefined();
    expect(safeUntil(shaped((ms) => ({ tempC: ms <= T0 + 60 * MIN ? 29 : 26, rh: 50 })), opts)).toEqual({ ms: T0 + 60 * MIN, limitedBy: 'temperature' });
    expect(safeUntil(shaped(fine, T0 + 10 * MIN), opts)).toEqual({ ms: T0 + 10 * MIN, limitedBy: 'battery' });
  });

  it('in the heating season, ends where the room drops below its minimum, and ignores the cooling maximum', () => {
    const heating = { ...opts, season: 'heating' as const };
    expect(safeUntil(shaped((ms) => ({ tempC: ms >= T0 + 3 * H ? 17.9 : 30, rh: 50 })), heating)).toEqual({ ms: T0 + 3 * H, limitedBy: 'temperature' });
  });

  it('when the room ends on two limits at once, the battery is named first', () => {
    expect(safeUntil(shaped((ms) => ({ tempC: ms >= T0 + 2 * H ? 28 : 26, rh: 50 }), T0 + 2 * H), opts)).toEqual({ ms: T0 + 2 * H, limitedBy: 'battery' });
  });
});
