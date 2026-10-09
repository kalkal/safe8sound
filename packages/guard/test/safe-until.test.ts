import { celsius, pct, watt } from '@cold-reserve/contracts';
import type { ProjectionPoint } from '@cold-reserve/core';
import { describe, expect, it } from 'vitest';
import { projectFrom } from '../src/context.js';
import { nightCoolingLimit, safeUntil } from '../src/safe-until.js';
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

  it('ends where the room goes above its maximum, or under its humidity minimum where the plan dries it', () => {
    expect(safeUntil(shaped((ms) => ({ tempC: ms >= T0 + 5 * H ? 27.2 : 26, rh: 50 })), opts)).toEqual({ ms: T0 + 5 * H, limitedBy: 'temperature' });
    // Under the minimum only where the plan dries the room (#107): cooling cannot raise the humidity.
    expect(safeUntil(shaped((ms) => ({ tempC: 26, rh: ms >= T0 + 4 * H ? 39 : 50 })), { ...opts, driesAt: () => true })).toEqual({ ms: T0 + 4 * H, limitedBy: 'humidity' });
    expect(safeUntil(shaped((ms) => ({ tempC: 26, rh: ms >= T0 + 4 * H ? 39 : 50 })), opts)).toBeUndefined();
  });

  it('accepts the limits themselves', () => {
    expect(safeUntil(shaped(() => ({ tempC: 27, rh: 30 })), opts)).toBeUndefined();
    expect(safeUntil(shaped(() => ({ tempC: 26, rh: 40 })), opts)).toBeUndefined();
  });

  describe('heat danger (#248)', () => {
    it('humid air alone does not end the safe hours', () => {
      expect(safeUntil(shaped(() => ({ tempC: 24, rh: 69 })), opts)).toBeUndefined();
      expect(safeUntil(shaped((ms) => ({ tempC: 26, rh: ms >= T0 + 4 * H ? 61 : 50 })), opts)).toBeUndefined();
    });

    it('ends where the room feels hotter than the limit in force: 26 °C at 90 % under a 26 °C limit; 24 °C at 69 % stays safe under a 24 °C night limit for an older person', () => {
      const night = (ms: number) => (ms >= T0 + 3 * H ? 24 : 27);
      // 24 °C at 69 % reads 24 °C: still safe at night; 26 °C at 90 % feels like 26.5 °C.
      expect(safeUntil(shaped(() => ({ tempC: 24, rh: 69 })), { ...opts, coolingMaxAt: night, elderly: true })).toBeUndefined();
      expect(safeUntil(shaped(() => ({ tempC: 26, rh: 90 })), { ...opts, safety: { ...opts.safety, cooling: { maxC: 26 } } })).toEqual({ ms: T0 + H, limitedBy: 'temperature' });
      expect(safeUntil(shaped(() => ({ tempC: 26, rh: 90 })), opts)).toBeUndefined();
    });

    it('stricter caps from the settings end the safe hours earlier (#266); a looser stored cap plays the constant', () => {
      const lax = { ...opts, safety: { ...opts.safety, cooling: { maxC: 40 } } };
      const warm = shaped((ms) => ({ tempC: ms >= T0 + 2 * H ? 29 : 26, rh: 50 }));
      expect(safeUntil(warm, lax)).toBeUndefined();
      expect(safeUntil(warm, { ...lax, safety: { ...lax.safety, heatIndexCapC: 29 } })).toEqual({ ms: T0 + 2 * H, limitedBy: 'temperature' });
      expect(safeUntil(shaped((ms) => ({ tempC: ms >= T0 + 2 * H ? 30 : 26, rh: 60 })), { ...lax, safety: { ...lax.safety, heatIndexCapC: 35 } })).toEqual({ ms: T0 + 2 * H, limitedBy: 'temperature' });
    });

    it('the fixed caps end the safe hours whatever the limit', () => {
      const lax = { ...opts, safety: { ...opts.safety, cooling: { maxC: 40 } } };
      expect(safeUntil(shaped((ms) => ({ tempC: ms >= T0 + 2 * H ? 30 : 26, rh: 60 })), lax)).toEqual({ ms: T0 + 2 * H, limitedBy: 'temperature' });
      expect(safeUntil(shaped((ms) => ({ tempC: ms >= T0 + 2 * H ? 31.1 : 26, rh: 20 })), { ...lax, elderly: true })).toEqual({ ms: T0 + 2 * H, limitedBy: 'temperature' });
      expect(safeUntil(shaped((ms) => ({ tempC: ms >= T0 + 2 * H ? 31.1 : 26, rh: 20 })), lax)).toBeUndefined();
    });
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

  describe('with the night threshold (#160: the health limit at night cannot be overridden)', () => {
    const night = { windowStartHour: 22, windowEndHour: 7, thresholdC: { standard: 26, elderly: 24 } };
    const tz = 'Europe/Rome';

    it('the cooling limit is the lower of the safety maximum and the night threshold, at night only', () => {
      const at = (iso: string) => Date.parse(iso);
      const limit = nightCoolingLimit({ maxC: 27, tz, night, mode: 'standard' });
      expect(limit(at('2026-07-17T21:59:00+02:00'))).toBe(27);
      expect(limit(at('2026-07-17T22:00:00+02:00'))).toBe(26);
      expect(limit(at('2026-07-18T06:59:00+02:00'))).toBe(26);
      expect(limit(at('2026-07-18T07:00:00+02:00'))).toBe(27);
      expect(nightCoolingLimit({ maxC: 27, tz, night, mode: 'elderly' })(at('2026-07-18T01:00:00+02:00'))).toBe(24);
      expect(nightCoolingLimit({ maxC: 30, tz, night, mode: 'standard' })(at('2026-07-18T01:00:00+02:00'))).toBe(26);
      expect(nightCoolingLimit({ maxC: 25, tz, night, mode: 'standard' })(at('2026-07-18T01:00:00+02:00'))).toBe(25);
    });

    it('safeUntil ends where the room crosses the limit in force at that point', () => {
      const lower = (ms: number) => (ms >= T0 + 3 * H ? 26 : 27);
      expect(safeUntil(shaped(() => ({ tempC: 26.5, rh: 50 })), { ...opts, coolingMaxAt: lower })).toEqual({ ms: T0 + 3 * H, limitedBy: 'temperature' });
      expect(safeUntil(shaped(() => ({ tempC: 26, rh: 50 })), { ...opts, coolingMaxAt: lower })).toBeUndefined();
    });
  });

  describe('at its edges (mutation survivors of #128)', () => {
    it('load unserved up to the dispatch tolerance is not a flat battery', () => {
      const points = shaped(fine).map((p, i) => (i === 10 ? { ...p, flows: { ...p.flows, unservedLoadW: watt(1) } } : p));
      expect(safeUntil(points, opts)).toBeUndefined();
    });

    it('looks at the safe room only', () => {
      const other = base.map((p) => ({ ...p, rooms: p.rooms.map((r) => ({ ...r, tempC: celsius(r.id === 'bedroom-1' ? 26 : 30), humidityPct: pct(r.id === 'bedroom-1' ? 50 : 90) })) }));
      expect(safeUntil(other, opts)).toBeUndefined();
      expect(safeUntil(other, { ...opts, roomId: 'attic' })).toBeUndefined();
    });

    it('the temperature limits are exact, and each applies only in its season', () => {
      const at = (t: number) => shaped((ms) => ({ tempC: ms >= T0 + 2 * H ? t : 26, rh: 30 }));
      expect(safeUntil(at(27 + 1e-9), opts)).toBeUndefined();
      expect(safeUntil(at(27 + 2e-9), opts)?.limitedBy).toBe('temperature');
      expect(safeUntil(at(17), opts)).toBeUndefined();
      const heating = { ...opts, season: 'heating' as const };
      expect(safeUntil(at(18 - 1e-9), heating)).toBeUndefined();
      expect(safeUntil(at(18 - 2e-9), heating)?.limitedBy).toBe('temperature');
      expect(safeUntil(at(18 - 5e-10), { ...opts, season: 'neutral' })).toBeUndefined();
    });

    it('the humidity minimum is exact and counts only where the plan dries', () => {
      const at = (rh: number) => shaped((ms) => ({ tempC: 26, rh: ms >= T0 + 2 * H ? rh : 50 }));
      const drying = { ...opts, driesAt: () => true };
      expect(safeUntil(at(40 - 1e-9), drying)).toBeUndefined();
      expect(safeUntil(at(40 - 5e-10), drying)).toBeUndefined();
      expect(safeUntil(at(40 - 2e-9), drying)?.limitedBy).toBe('humidity');
    });
  });
});
