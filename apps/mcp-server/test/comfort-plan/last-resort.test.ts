import { LAST_RESORT_ACTIONS } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { lastResortActions, lastResortWindow } from '../../src/modules/comfort-plan/last-resort.js';

// The honest window of a last resort (#160): the limit the safe room keeps from now until safeUntil, then how
// far it goes and by when, along the projection of the chosen plan.

const H = 3_600_000;
const T0 = Date.parse('2026-07-17T20:00:00Z');
const points = (temps: readonly number[]) => temps.map((t, i) => ({ ms: T0 + i * H, rooms: [{ id: 'bedroom-1', tempC: t }, { id: 'living', tempC: 40 }] }));
const opts = { nowMs: T0, roomId: 'bedroom-1', season: 'cooling' as const, limitAt: () => 27, claimsUntil: true };

describe('lastResortWindow', () => {
  it('cooling: the limit kept until safeUntil, then the warmest point from there on, and when', () => {
    const w = lastResortWindow(points([25, 26, 27, 27.6, 29.24, 28.5]), { ...opts, untilMs: T0 + 3 * H });
    expect(w).toEqual({ comfortLimitC: 27, worstC: 29.2, worstAtMs: T0 + 4 * H });
  });

  it('heating: the minimum kept, then the coldest point', () => {
    const w = lastResortWindow(points([20, 19, 17.5, 16.86, 17]), { ...opts, season: 'heating', limitAt: () => 18, untilMs: T0 + 2 * H });
    expect(w).toEqual({ comfortLimitC: 18, worstC: 16.9, worstAtMs: T0 + 3 * H });
  });

  it('the limit is the one in force at safeUntil: the night threshold, when the night lowers it', () => {
    const night = (ms: number) => (ms >= T0 + 2 * H ? 26 : 27);
    const w = lastResortWindow(points([25.5, 25.8, 26, 26.4, 27.1]), { ...opts, limitAt: night, untilMs: T0 + 3 * H });
    expect(w).toEqual({ comfortLimitC: 26, worstC: 27.1, worstAtMs: T0 + 4 * H });
  });

  it('says nothing when the room is past that limit before safeUntil (the grace period, or a lower night limit)', () => {
    expect(lastResortWindow(points([30, 26, 26.5, 27.4]), { ...opts, untilMs: T0 + 2 * H })).toBeUndefined();
    const night = (ms: number) => (ms >= T0 + 2 * H ? 24 : 27);
    expect(lastResortWindow(points([26, 26, 26, 27]), { ...opts, limitAt: night, untilMs: T0 + 2 * H })).toBeUndefined();
    expect(lastResortWindow(points([20, 17.5, 18, 17]), { ...opts, season: 'heating', limitAt: () => 18, untilMs: T0 + 2 * H })).toBeUndefined();
  });

  it('when the battery ends the safe hours nothing is claimed before it, so an earlier peak does not matter', () => {
    const w = lastResortWindow(points([26.5, 26.5, 26, 27.4]), { ...opts, limitAt: (ms) => (ms >= T0 + 2 * H ? 26 : 27), claimsUntil: false, untilMs: T0 + 2 * H });
    expect(w).toEqual({ comfortLimitC: 26, worstC: 27.4, worstAtMs: T0 + 3 * H });
  });

  it('looks from now on: a point before now does not count', () => {
    const w = lastResortWindow(points([30, 26, 26.5, 27.4]), { ...opts, nowMs: T0 + H, untilMs: T0 + 2 * H });
    expect(w).toEqual({ comfortLimitC: 27, worstC: 27.4, worstAtMs: T0 + 3 * H });
  });

  it('the limit itself is still inside', () => {
    expect(lastResortWindow(points([27, 27, 28]), { ...opts, untilMs: T0 + 2 * H })?.worstC).toBe(28);
  });

  it('the first of equal worst points, so the time is the earliest it gets there', () => {
    const w = lastResortWindow(points([26, 28, 28, 27]), { ...opts, untilMs: T0 + H });
    expect(w?.worstAtMs).toBe(T0 + H);
  });

  it('looks at the safe room only', () => {
    const w = lastResortWindow(points([26, 27.5]), { ...opts, untilMs: T0 + H });
    expect(w?.worstC).toBe(27.5);
  });

  it('is undefined when the room stays inside its limit after safeUntil too (the battery or the humidity end the safe hours)', () => {
    expect(lastResortWindow(points([26, 26.5, 27]), { ...opts, untilMs: T0 + H })).toBeUndefined();
    expect(lastResortWindow(points([26, 27.04]), { ...opts, untilMs: T0 + H })).toBeUndefined();
    expect(lastResortWindow(points([20, 18, 18.04]), { ...opts, season: 'heating', limitAt: () => 18, untilMs: T0 + H })).toBeUndefined();
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

describe('lastResortActions', () => {
  it('in the heat, every sourced action; with no heat to fight, none', () => {
    expect(lastResortActions('cooling')).toEqual([...LAST_RESORT_ACTIONS]);
    expect(lastResortActions('neutral')).toEqual([...LAST_RESORT_ACTIONS]);
    expect(lastResortActions('heating')).toEqual([]);
  });
});
