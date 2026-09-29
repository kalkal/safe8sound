import { GUARANTEE_IDS, HomeProfileSchema, type GuaranteeId } from '@cold-reserve/contracts';
import { exampleHomeProfile } from '@cold-reserve/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import { CONSTRAINTS, rejectionOf, runGuard, type GuardVerdict } from '../src/index.js';
import { H, T0, input, plan, snapshot, step } from './support.js';

const g = (v: GuardVerdict, id: GuaranteeId) => {
  const found = v.guarantees.find((x) => x.id === id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found;
};

const coolAll = (setpointC: number) => ['bedroom-1', 'living', 'study'].map((roomId) => step({ roomId, setpointC }));

describe('runGuard: the composite (plan §9.2)', () => {
  it('returns all five guarantees, in the contract order, every time', () => {
    const v = runGuard(input());
    expect(v.guarantees.map((x) => x.id)).toEqual([...GUARANTEE_IDS]);
    expect(CONSTRAINTS.map((c) => c.id)).toEqual([...GUARANTEE_IDS]);
  });

  it('accepts a sensible plan: the safe room cooled at 25 °C on grid', () => {
    const v = runGuard(input());
    expect(v.guarantees.filter((x) => !x.ok)).toEqual([]);
    expect(v.ok).toBe(true);
    expect(rejectionOf(v)).toBeUndefined();
  });

  it('runs every constraint without stopping at the first failure', () => {
    const v = runGuard(input({ snapshot: snapshot({ gridAvailable: false }), plan: plan([step({ roomId: 'living', setpointC: 18, targetPct: 99 }), step({ mode: 'off', targetPct: 99 })]) }));
    expect(g(v, 'inverter_limit').ok).toBe(true);
    const failing = v.guarantees.filter((x) => !x.ok).map((x) => x.id);
    expect(failing).toContain('safe_room_comfort');
    expect(failing.length).toBeGreaterThanOrEqual(2);
    expect(v.ok).toBe(false);
  });

  it('never modifies the plan or any input', () => {
    const i = input({ plan: plan(coolAll(18)) });
    const before = structuredClone(i);
    runGuard(i);
    expect(i).toEqual(before);
  });
});

describe('storm_reserve', () => {
  it('rejects a target below the reserve floor and gives the floor as the nearest allowed value', () => {
    const v = runGuard(input({ plan: plan([step({ targetPct: 20 })]) }));
    const r = g(v, 'storm_reserve');
    expect(r.ok).toBe(false);
    expect(r.unit).toBe('%');
    // 350 W for the 10 dark hours (21:00-07:00) at 0.884: 3.96 kWh, i.e. 25.8 % of 15.33 kWh above the 10 % floor.
    expect(v.reserveFloorSocPct).toBeCloseTo(35.8, 1);
    // Rounded up to one decimal, so re-planning with it passes.
    expect(r.limit).toBe(35.9);
    expect(r.nearestAllowed).toBe(r.limit);
    expect(rejectionOf(v)?.code).toBe('storm_reserve_violated');
  });

  it('accepts a target exactly at the floor (boundary)', () => {
    const floor = runGuard(input()).reserveFloorSocPct;
    expect(g(runGuard(input({ plan: plan([step({ targetPct: floor })]) })), 'storm_reserve').ok).toBe(true);
  });

  it('with the grid down, the reserve becomes the safe room budget', () => {
    const r = g(runGuard(input({ snapshot: snapshot({ gridAvailable: false }), plan: plan([step({ targetPct: 20 })]) })), 'storm_reserve');
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/grid is down/i);
  });
});

describe('inverter_limit', () => {
  it('rejects three splits pulling down at once off grid (EPS 5 kW)', () => {
    const r = g(runGuard(input({ snapshot: snapshot({ gridAvailable: false }), plan: plan(coolAll(18)) })), 'inverter_limit');
    expect(r.ok).toBe(false);
    expect(r.limit).toBe(5000);
    expect(r.measured).toBeGreaterThan(5000);
    expect(r.nearestAllowed).toBe(5000);
    expect(r.unit).toBe('W');
  });

  it('uses the inverter rating on grid (6 kW) and accepts two rooms at once', () => {
    expect(g(runGuard(input({ plan: plan(coolAll(18)) })), 'inverter_limit').limit).toBe(6000);
    expect(g(runGuard(input({ plan: plan(coolAll(18).slice(0, 2)) })), 'inverter_limit').ok).toBe(true);
  });
});

describe('battery_power', () => {
  it('rejects a load the battery cannot deliver off grid', () => {
    const weak = HomeProfileSchema.parse({ ...exampleHomeProfile(), battery: { ...exampleHomeProfile().battery, maxDischargeW: 1000 } });
    const r = g(runGuard(input({ profile: weak, snapshot: snapshot({ gridAvailable: false }), plan: plan([step({ setpointC: 18 })]) })), 'battery_power');
    expect(r.ok).toBe(false);
    expect(r.limit).toBe(1000);
    expect(r.nearestAllowed).toBe(1000);
  });

  it('rejects a trajectory that asks the battery for more than its rated power', () => {
    const steps = [step({ targetPct: 90 }), step({ atMs: T0 + H, targetPct: 40 })];
    const r = g(runGuard(input({ plan: plan(steps) })), 'battery_power');
    expect(r.ok).toBe(false);
    expect(r.measured).toBeGreaterThan(5000);
  });

  it('accepts a gentle trajectory', () => {
    const steps = [step({ targetPct: 90 }), step({ atMs: T0 + 4 * H, targetPct: 80 })];
    expect(g(runGuard(input({ plan: plan(steps) })), 'battery_power').ok).toBe(true);
  });
});

describe('safe_room_comfort (measured air and humidity only, plan §3.1)', () => {
  it('rejects a plan that leaves the safe room above the cooling maximum', () => {
    const r = g(runGuard(input({ plan: plan([step({ mode: 'off' })]) })), 'safe_room_comfort');
    expect(r.ok).toBe(false);
    expect(r.limit).toBe(27);
    expect(r.nearestAllowed).toBe(27);
    expect(r.unit).toBe('C');
  });

  it('checks the heating minimum in the heating season', () => {
    const r = g(runGuard(input({ season: 'heating', plan: plan([step({ mode: 'off' })]) })), 'safe_room_comfort');
    expect(r.ok).toBe(true);
  });

  it('ignores the fan: a fan never moves the safety threshold', () => {
    const r = g(runGuard(input({ plan: plan([step({ mode: 'fan_only', fanOn: true })]) })), 'safe_room_comfort');
    expect(r.ok).toBe(false);
  });
});

describe('pacing_on_track', () => {
  it('rejects a plan that empties the battery before the next recharge (off grid)', () => {
    const v = runGuard(input({ snapshot: snapshot({ gridAvailable: false, socPct: 25 }), plan: plan([step({ setpointC: 21, targetPct: 25 })]) }));
    const r = g(v, 'pacing_on_track');
    expect(r.ok).toBe(false);
    expect(r.unit).toBe('min');
    expect(r.measured).toBeGreaterThan(0);
    expect(rejectionOf(v)?.code).toBeDefined();
  });

  it('rejects a trajectory the projection cannot follow', () => {
    const r = g(runGuard(input({ plan: plan([step({ targetPct: 99 })]) })), 'pacing_on_track');
    expect(r.ok).toBe(false);
    expect(r.unit).toBe('%');
  });
});
