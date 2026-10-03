import { LAST_RESORT_ACTIONS } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { lastResortActions, lastResortWindow, loweredLimit } from '../../src/modules/comfort-plan/last-resort.js';

// The honest window of a last resort (#160): from safeUntil on, the point where the safe room is furthest past
// the limit in force at that point (the night threshold lowers it), that limit, and when.

const H = 3_600_000;
const T0 = Date.parse('2026-07-17T20:00:00Z');
const points = (temps: readonly number[]) => temps.map((t, i) => ({ ms: T0 + i * H, rooms: [{ id: 'bedroom-1', tempC: t }, { id: 'living', tempC: 40 }] }));
const opts = { roomId: 'bedroom-1', season: 'cooling' as const, limitAt: () => 27 };
/** 27 °C by day, 26 °C from T0 + 2 h (the night window). */
const night = (ms: number) => (ms >= T0 + 2 * H ? 26 : 27);

describe('lastResortWindow', () => {
  it('cooling: the warmest point past its limit from safeUntil on, its limit, and when', () => {
    const w = lastResortWindow(points([25, 26, 27, 27.6, 29.24, 28.5]), { ...opts, untilMs: T0 + 3 * H });
    expect(w).toEqual({ comfortLimitC: 27, worstC: 29.2, worstAtMs: T0 + 4 * H });
  });

  it('heating: the coldest point under the minimum', () => {
    const w = lastResortWindow(points([20, 19, 17.5, 16.86, 17]), { ...opts, season: 'heating', limitAt: () => 18, untilMs: T0 + 2 * H });
    expect(w).toEqual({ comfortLimitC: 18, worstC: 16.9, worstAtMs: T0 + 3 * H });
  });

  it('compares each point with the limit in force there: a night peak of 26.8 °C is past the 26 °C night limit', () => {
    // The battery runs out at T0 + 1 h, before the night: by day 26.5 °C is inside, at night 26.8 °C is not.
    const w = lastResortWindow(points([25, 26.5, 26.8, 26.2]), { ...opts, limitAt: night, untilMs: T0 + H });
    expect(w).toEqual({ comfortLimitC: 26, worstC: 26.8, worstAtMs: T0 + 2 * H });
  });

  it('reports the limit at the worst point: 27.5 °C at night is past the 26 °C night limit, not the 27 °C day one', () => {
    const w = lastResortWindow(points([25, 26, 27.5, 26.5]), { ...opts, limitAt: night, untilMs: T0 + H });
    expect(w).toEqual({ comfortLimitC: 26, worstC: 27.5, worstAtMs: T0 + 2 * H });
  });

  it('when the night lowers the limit at safeUntil, the room above it gives the window (the elderly case)', () => {
    const elderly = (ms: number) => (ms >= T0 + 2 * H ? 24 : 27);
    const w = lastResortWindow(points([26, 26, 26, 25.4, 24.5]), { ...opts, limitAt: elderly, untilMs: T0 + 2 * H });
    expect(w).toEqual({ comfortLimitC: 24, worstC: 26, worstAtMs: T0 + 2 * H });
  });

  it('looks from safeUntil on only', () => {
    expect(lastResortWindow(points([30, 26, 26.5]), { ...opts, untilMs: T0 + H })).toBeUndefined();
  });

  it('the first of equal worst points, so the time is the earliest it gets there', () => {
    expect(lastResortWindow(points([26, 28, 28, 27]), { ...opts, untilMs: T0 + H })?.worstAtMs).toBe(T0 + H);
  });

  it('looks at the safe room only', () => {
    expect(lastResortWindow(points([26, 27.5]), { ...opts, untilMs: T0 + H })?.worstC).toBe(27.5);
  });

  it('is undefined when no point from safeUntil on is past its limit, even once rounded', () => {
    expect(lastResortWindow(points([26, 26.5, 27]), { ...opts, untilMs: T0 + H })).toBeUndefined();
    expect(lastResortWindow(points([26, 27.04]), { ...opts, untilMs: T0 + H })).toBeUndefined();
    expect(lastResortWindow(points([20, 18, 18.04]), { ...opts, season: 'heating', limitAt: () => 18, untilMs: T0 + H })).toBeUndefined();
    expect(lastResortWindow(points([20, 17.96]), { ...opts, season: 'heating', limitAt: () => 18, untilMs: T0 + H })).toBeUndefined();
    expect(lastResortWindow(points([20, 17.94]), { ...opts, season: 'heating', limitAt: () => 18, untilMs: T0 + H })?.worstC).toBe(17.9);
  });

  it('is undefined when the projection has no point from safeUntil on, or no safe room', () => {
    expect(lastResortWindow(points([26, 27]), { ...opts, untilMs: T0 + 5 * H })).toBeUndefined();
    expect(lastResortWindow(points([26, 27.5]), { ...opts, roomId: 'attic', untilMs: T0 + H })).toBeUndefined();
  });

  it('the neutral season reads like cooling', () => {
    expect(lastResortWindow(points([26, 27.5]), { ...opts, season: 'neutral', untilMs: T0 + H })?.comfortLimitC).toBe(27);
  });
});

describe('loweredLimit: the safe hours end because the limit came down, not because the room crossed it', () => {
  const at = { roomId: 'bedroom-1', stepMs: H, limitAt: (ms: number) => (ms >= T0 + 2 * H ? 24 : 27) };

  it('the limit drops at safeUntil, the room was inside the one before and is above the new one: that new limit', () => {
    expect(loweredLimit(points([26, 26, 25, 24.5]), { ...at, untilMs: T0 + 2 * H })).toBe(24);
  });

  it('not when the limit did not change there (a crossing, even at 10 PM)', () => {
    expect(loweredLimit(points([23, 23.5, 24.5]), { ...at, limitAt: () => 24, untilMs: T0 + 2 * H })).toBeUndefined();
  });

  it('not when the room was already past the earlier limit, nor when it is inside the new one', () => {
    expect(loweredLimit(points([26, 27.5, 25]), { ...at, untilMs: T0 + 2 * H })).toBeUndefined();
    expect(loweredLimit(points([23, 23, 23.5]), { ...at, untilMs: T0 + 2 * H })).toBeUndefined();
  });

  it('the limit changes between two grid points: the first point after the change is the one that sees it', () => {
    // The limit comes down at T0 + 1.5 h; the points are on the hour.
    const between = { ...at, limitAt: (ms: number) => (ms >= T0 + 1.5 * H ? 24 : 27) };
    expect(loweredLimit(points([26, 26, 25]), { ...between, untilMs: T0 + 2 * H })).toBe(24);
    expect(loweredLimit(points([26, 26, 25]), { ...between, untilMs: T0 + H })).toBeUndefined();
  });

  it('not without both points of the safe room', () => {
    expect(loweredLimit(points([26, 26, 25]), { ...at, untilMs: T0 })).toBeUndefined();
    expect(loweredLimit(points([26, 26, 25]), { ...at, roomId: 'attic', untilMs: T0 + 2 * H })).toBeUndefined();
  });
});

describe('lastResortActions', () => {
  it('in the heat, every sourced action; with no heat to fight, none', () => {
    expect(lastResortActions('cooling')).toEqual([...LAST_RESORT_ACTIONS]);
    expect(lastResortActions('neutral')).toEqual([...LAST_RESORT_ACTIONS]);
    expect(lastResortActions('heating')).toEqual([]);
  });
});
