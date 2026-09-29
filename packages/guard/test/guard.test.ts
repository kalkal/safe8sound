import { ForecastSchema, GUARANTEE_IDS, HomeProfileSchema, PreferencesSchema, NightRecoverySchema, type GuaranteeId } from '@cold-reserve/contracts';
import { exampleHomeProfile } from '@cold-reserve/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import { CONSTRAINTS, rejectionOf, runGuard, type GuardVerdict } from '../src/index.js';
import { H, T0, config, hotNight, input, iso, plan, preferences, snapshot, step } from './support.js';

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

describe('night recovery (feature queue item 1)', () => {
  it('is met when the bedroom stays at 25 °C all night', () => {
    const n = runGuard(input()).nightRecovery;
    expect(n && NightRecoverySchema.parse(n).status).toBe('met');
    expect(n?.achievedHours).toBeGreaterThanOrEqual(n?.requiredHours ?? Infinity);
    expect(n?.window.start).toBe('2026-07-15T20:00:00.000Z');
  });

  it('rejects a plan that misses a reachable target', () => {
    const v = runGuard(input({ plan: plan([step({ mode: 'off' })]) }));
    expect(v.nightRecovery?.status).toBe('unmet');
    expect(v.ok).toBe(false);
  });

  it('elderly mode needs 24 °C: a 25 °C plan is unmet', () => {
    const v = runGuard(input({ nightRecoveryMode: 'elderly' }));
    expect(v.nightRecovery?.thresholdC).toBe(24);
    expect(v.nightRecovery?.status).toBe('unmet');
    expect(v.guarantees.every((x) => x.ok)).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.warnings).toEqual([]);
    expect(rejectionOf(v)?.code).toBe('night_recovery_unmet');
  });

  it('says honestly when the battery cannot do it: infeasible, best hours, a warning, not a rejection', () => {
    const v = runGuard(input({ snapshot: snapshot({ gridAvailable: false, socPct: 11 }), plan: plan([step({ targetPct: 11 })]) }));
    const n = v.nightRecovery;
    expect(n?.status).toBe('infeasible');
    expect(n?.bestAchievableHours).toBeLessThan(n?.requiredHours ?? 0);
    expect(v.warnings.map((w) => w.code)).toEqual(['night_recovery_infeasible']);
    expect(v.warnings[0]?.message).toMatch(/^Tonight the battery can keep the Bedroom at or below 26 °C for about \d+(\.\d+)? hours, not the 6 hours of the night-recovery target\.$/);
    expect(n?.bestAchievableHours).toBeGreaterThanOrEqual(n?.achievedHours ?? Infinity);
    expect(rejectionOf(v)?.code).not.toBe('night_recovery_unmet');
  });

  it('does not call a target feasible when reaching it would run the battery out before dawn', () => {
    // Off grid at 30 %: cooling the bedroom to 23.5 °C all night would reach the hours, then leave the
    // safe room without power before the 07:00 recharge.
    const v = runGuard(input({ nightRecoveryMode: 'elderly', snapshot: snapshot({ gridAvailable: false, socPct: 30 }), plan: plan([step({ mode: 'fan_only', targetPct: 10 })]) }));
    expect(v.nightRecovery?.status).toBe('infeasible');
    expect(v.nightRecovery?.bestAchievableHours).toBe(v.nightRecovery?.achievedHours);
  });

  it('does not call a target feasible when reaching it would take the room out of its humidity band', () => {
    // A humid night: cooling to 23.5 °C would reach the hours, with the room far above 60 % RH.
    const humid = ForecastSchema.parse({ ...hotNight(), hourly: hotNight().hourly.map((h) => ({ ...h, humidityOutPct: 95 })) });
    const v = runGuard(input({ nightRecoveryMode: 'elderly', forecast: humid, plan: plan([step({ mode: 'fan_only', targetPct: 40 })]) }));
    expect(v.nightRecovery?.status).toBe('infeasible');
  });

  it('off grid with a full battery the target is reachable: missing it is a rejection', () => {
    const v = runGuard(input({ snapshot: snapshot({ gridAvailable: false, socPct: 100 }), plan: plan([step({ mode: 'fan_only', targetPct: 10 })]) }));
    expect(v.nightRecovery?.status).toBe('unmet');
  });

  it('a reference that leaves the humidity band proves nothing (tight band)', () => {
    const tight = PreferencesSchema.parse({ ...preferences, safety: { ...preferences.safety, humidity: { minPct: 30, maxPct: 40 } } });
    const v = runGuard(input({ preferences: tight, plan: plan([step({ mode: 'fan_only' })]) }));
    expect(v.nightRecovery?.status).toBe('infeasible');
  });

  it('reports the reference hours as the best when they beat the plan', () => {
    const nine = config((c) => ({ ...c, nightRecovery: { ...c.nightRecovery, requiredHours: 24 } }));
    const v = runGuard(input({ config: nine, plan: plan([step({ mode: 'fan_only' })]) }));
    expect(v.nightRecovery?.status).toBe('infeasible');
    expect(v.nightRecovery?.bestAchievableHours).toBeGreaterThan(v.nightRecovery?.achievedHours ?? Infinity);
  });

  it('is not evaluated outside the cooling season', () => {
    const v = runGuard(input({ season: 'heating' }));
    expect('nightRecovery' in v).toBe(false);
    expect(v.warnings).toEqual([]);
  });

  it('is not evaluated when the projection has no night', () => {
    const morning = Date.parse('2026-07-16T08:00:00+02:00');
    const day = ForecastSchema.parse({
      ...hotNight(),
      hourly: Array.from({ length: 6 }, (_, i) => ({ ts: iso(morning + i * H), tempOutC: 30, humidityOutPct: 50, irradianceWm2: 700, stormProb: 0 })),
    });
    const v = runGuard(input({ forecast: day, snapshot: snapshot({ ms: morning }), plan: plan([step({ atMs: morning })], morning + 3 * H) }));
    expect('nightRecovery' in v).toBe(false);
    expect(v.warnings).toEqual([]);
  });

  it('is met with no warning', () => {
    const v = runGuard(input());
    expect(v.nightRecovery?.status).toBe('met');
    expect(v.warnings).toEqual([]);
  });
});
