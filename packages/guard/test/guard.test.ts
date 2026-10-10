import { ForecastSchema, GUARANTEE_IDS, HomeProfileSchema, PreferencesSchema, NightRecoverySchema, pct, type GuaranteeId } from '@cold-reserve/contracts';
import { exampleHomeProfile } from '@cold-reserve/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import { CONSTRAINTS, rejectionOf, runGuard, type GuardVerdict } from '../src/index.js';
import { H, T0, config, hotNight, input, iso, plan, preferences, profile, snapshot, step } from './support.js';

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
  it('off grid measures against the EPS rating (5 kW), where only the safe room runs', () => {
    // Off grid only the EPS circuits are powered (#19): the other rooms' splits get no power, so three
    // splits pulling down at once draw what the safe room's alone does.
    const all = g(runGuard(input({ snapshot: snapshot({ gridAvailable: false }), plan: plan(coolAll(18)) })), 'inverter_limit');
    const safeOnly = g(runGuard(input({ snapshot: snapshot({ gridAvailable: false }), plan: plan(coolAll(18).slice(0, 1)) })), 'inverter_limit');
    expect(all).toMatchObject({ ok: true, limit: 5000, unit: 'W' });
    expect(all.measured).toBe(safeOnly.measured);
  });

  it('rejects a load over the EPS rating off grid, with the nearest allowed value', () => {
    // A tighter EPS: 1 kW is less than the safe room's split pulling down at full power.
    const tight = HomeProfileSchema.parse({ ...profile, eps: { ...profile.eps, continuousVa: 1000 } });
    const r = g(runGuard(input({ profile: tight, snapshot: snapshot({ gridAvailable: false }), plan: plan(coolAll(18)) })), 'inverter_limit');
    expect(r.ok).toBe(false);
    expect(r.limit).toBe(1000);
    expect(r.measured).toBeGreaterThan(1000);
    expect(r.nearestAllowed).toBe(1000);
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

describe('dry air (#107): the plan cannot raise the humidity', () => {
  // A dry afternoon: the bedroom at 35 %, the person's minimum at 42 %.
  const dryPrefs = PreferencesSchema.parse({ ...preferences, safety: { ...preferences.safety, humidity: { minPct: 42, maxPct: 60 } } });
  const dryRoom = () => {
    const s = snapshot();
    return { ...s, rooms: s.rooms.map((r) => ({ ...r, humidityPct: pct(35) })) };
  };

  it('a cooling plan in air drier than the minimum is accepted, with a warning that says what helps', () => {
    const v = runGuard(input({ preferences: dryPrefs, snapshot: dryRoom() }));
    expect(v.guarantees.find((x) => x.id === 'safe_room_comfort')?.ok).toBe(true);
    const w = v.warnings.find((x) => x.code === 'dry_air');
    expect(w?.message).toMatch(/^The air in the Bedroom is dry \(down to \d+ %, under 42 %\) and cooling cannot raise it: drink water; a damp cloth or a bowl of water in the room helps\.$/);
  });

  it('a drying plan that takes the room under the minimum is refused', () => {
    const v = runGuard(input({ preferences: dryPrefs, snapshot: dryRoom(), plan: plan([step({ mode: 'dry' })]) }));
    expect(v.guarantees.find((x) => x.id === 'safe_room_comfort')?.ok).toBe(false);
  });

  it('no warning when the air stays within the band', () => {
    expect(runGuard(input()).warnings.some((x) => x.code === 'dry_air')).toBe(false);
    expect(runGuard(input()).warnings.some((x) => x.code === 'humid_air')).toBe(false);
  });

  it('never says "no heat danger" when the safe room is in heat danger: no humid-air warning then (#285 review)', () => {
    // A humid band that every reading leaves, on a night too hot and humid for the room to stay under its maximum.
    const humidPrefs = PreferencesSchema.parse({ ...preferences, safety: { ...preferences.safety, humidity: { minPct: 30, maxPct: 50 } } });
    const scorching = ForecastSchema.parse({ ...hotNight(), hourly: hotNight().hourly.map((h) => ({ ...h, tempOutC: h.tempOutC + 12, humidityOutPct: 95 })) });
    const v = runGuard(input({ preferences: humidPrefs, forecast: scorching, plan: plan([step({ mode: 'fan_only' })]) }));
    expect(v.guarantees.find((x) => x.id === 'safe_room_comfort')?.ok).toBe(false);
    expect(v.warnings.some((x) => x.code === 'humid_air')).toBe(false);
  });

  it('a plan with the safe room humid but not hot is accepted, with the humid-air warning (#248)', () => {
    const humidPrefs = PreferencesSchema.parse({ ...preferences, safety: { ...preferences.safety, humidity: { minPct: 40, maxPct: 50 } } });
    const v = runGuard(input({ preferences: humidPrefs }));
    expect(v.guarantees.find((x) => x.id === 'safe_room_comfort')?.ok).toBe(true);
    expect(v.warnings.find((x) => x.code === 'humid_air')?.message).toMatch(/^The air in the Bedroom is humid \(up to \d+ %, over 50 %\): less comfortable and a risk of mould, but no heat danger at this temperature\.$/);
  });
});

describe('the temperature unit of the texts (#306): the guard computes in °C, only its words change', () => {
  const strings = (x: unknown): unknown => (typeof x === 'string' ? '' : Array.isArray(x) ? x.map(strings) : x !== null && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, strings(v)])) : x);
  const cases = {
    'a hot room with the AC off': input({ plan: plan([step({ mode: 'off' })]) }),
    'a scorching humid night': input({
      forecast: ForecastSchema.parse({ ...hotNight(), hourly: hotNight().hourly.map((h) => ({ ...h, tempOutC: h.tempOutC + 12, humidityOutPct: 95 })) }),
      plan: plan([step({ mode: 'fan_only' })]),
    }),
    'a sensible plan': input(),
  };

  it.each(Object.entries(cases))('%s: the same verdict, numbers and pass/fail in °C and °F; only the strings differ', (_name, i) => {
    const c = runGuard(i);
    const f = runGuard({ ...i, displayUnit: 'F' });
    expect(strings(f)).toEqual(strings(c));
    expect(JSON.stringify(f)).not.toContain('°C');
  });

  it('says the safe room in °F: 27 °C is 80.6 °F, and the nearest allowed value in °F too', () => {
    const i = input({ plan: plan([step({ mode: 'off' })]) });
    const f = runGuard({ ...i, displayUnit: 'F' });
    const room = f.guarantees.find((x) => x.id === 'safe_room_comfort');
    expect(room?.reason).toMatch(/above its 80\.6 °F maximum\.$/);
    // The structured numbers stay in °C for the cards.
    expect(room).toMatchObject({ limit: 27, unit: 'C' });
    expect(rejectionOf(f, 'F')?.message).toMatch(/ Nearest allowed: 80\.6 °F \(27 C\)\.$/);
    expect(rejectionOf(runGuard(i))?.message).toMatch(/ Nearest allowed: 27 C\.$/);
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

  it('on a hot end of night that requires no hour, a fan-only plan still answers for the heat budget', () => {
    // 05:00, 32 °C in the bedroom, only the fan: the 2 hours left of the window require no hour at or
    // below the threshold, but the heat goes far over the budget.
    const at = T0 + 9 * H;
    const v = runGuard(input({ snapshot: snapshot({ ms: at, tempC: 32 }), plan: plan([step({ atMs: at, mode: 'fan_only', targetPct: 40 })], at + 6 * H) }));
    const n = v.nightRecovery;
    expect(n?.requiredHours).toBe(0);
    expect(n?.heatIndexDegreeHoursAbove26_7).toBeGreaterThan(n?.budgetDegreeHours ?? Infinity);
    expect(n?.status).not.toBe('met');
    const said = n?.status === 'unmet' ? rejectionOf(v)?.message : v.warnings[0]?.message;
    expect(said).toMatch(/heat-index degree-hours above 26\.7 °C/);
    expect(said).not.toMatch(/of the 0|not the 0/);
  });

  it('an infeasible night over the heat budget says the heat, not "0 hours"', () => {
    const at = T0 + 9 * H;
    const v = runGuard(input({ snapshot: snapshot({ ms: at, tempC: 32, gridAvailable: false, socPct: 11 }), plan: plan([step({ atMs: at, mode: 'fan_only', targetPct: 11 })], at + 6 * H) }));
    expect(v.nightRecovery?.status).toBe('infeasible');
    expect(v.warnings[0]?.message).toMatch(/^Tonight the battery cannot keep the heat in the Bedroom within the night budget: about [\d.]+ heat-index degree-hours above 26\.7 °C, over the 4 allowed\.$/);
  });

  it('does not call a target feasible when reaching it would run the battery out before dawn', () => {
    // Off grid at 30 %: cooling the bedroom to 23.5 °C all night would reach the hours, then leave the
    // safe room without power before the 07:00 recharge.
    const v = runGuard(input({ nightRecoveryMode: 'elderly', snapshot: snapshot({ gridAvailable: false, socPct: 30 }), plan: plan([step({ mode: 'fan_only', targetPct: 10 })]) }));
    expect(v.nightRecovery?.status).toBe('infeasible');
    expect(v.nightRecovery?.bestAchievableHours).toBe(v.nightRecovery?.achievedHours);
  });

  it('a humid night alone does not make the target unreachable (#248): cooling still reaches the hours, so missing them is a rejection', () => {
    // Humid air is a warning, not a limit: the heat it adds is in the heat budget.
    const humid = ForecastSchema.parse({ ...hotNight(), hourly: hotNight().hourly.map((h) => ({ ...h, humidityOutPct: 95 })) });
    const v = runGuard(input({ nightRecoveryMode: 'elderly', forecast: humid, plan: plan([step({ mode: 'fan_only', targetPct: 40 })]) }));
    expect(v.nightRecovery?.status).toBe('unmet');
  });

  it('off grid with a full battery the target is reachable: missing it is a rejection', () => {
    const v = runGuard(input({ snapshot: snapshot({ gridAvailable: false, socPct: 100 }), plan: plan([step({ mode: 'fan_only', targetPct: 10 })]) }));
    expect(v.nightRecovery?.status).toBe('unmet');
  });

  it('a night too hot and humid for the air conditioner: the target is out of reach, said as the limit of the air conditioner', () => {
    // 12 °C hotter than the hot night, at 95 % RH: even the reference cannot hold the threshold for the hours.
    const scorching = ForecastSchema.parse({ ...hotNight(), hourly: hotNight().hourly.map((h) => ({ ...h, tempOutC: h.tempOutC + 12, humidityOutPct: 95 })) });
    const v = runGuard(input({ forecast: scorching, plan: plan([step({ mode: 'fan_only' })]) }));
    expect(v.nightRecovery?.status).toBe('infeasible');
    // With the grid up the limit is the air conditioner, not the battery.
    expect(v.warnings[0]?.message).toMatch(/^Tonight the air conditioner can keep the Bedroom/);
  });

  it('on the autumn clock-change night (10 hours long) it still requires only the configured hours', () => {
    // Europe/Rome, 24-25 October 2026: 03:00 becomes 02:00, so 22:00-07:00 lasts 10 hours.
    const start = Date.parse('2026-10-24T20:00:00+02:00');
    const october = ForecastSchema.parse({ ...hotNight(), fetchedAt: iso(start), hourly: hotNight().hourly.map((h, i) => ({ ...h, ts: iso(start + i * H) })) });
    const v = runGuard(input({ forecast: october, snapshot: snapshot({ ms: start }), plan: plan([step({ atMs: start })], start + 13 * H) }));
    expect(v.nightRecovery?.window.end).toBe('2026-10-25T06:00:00.000Z');
    expect(v.nightRecovery?.requiredHours).toBe(6);
  });

  it('a re-plan at 02:00 only requires the hours still needed (no false infeasible during a blackout)', () => {
    // 6 of the 9 night hours are required; at 02:00 only 5 remain, so 2 of them are still needed.
    const two = T0 + 6 * H;
    const v = runGuard(input({ snapshot: snapshot({ ms: two, gridAvailable: false, socPct: 60, tempC: 26 }), plan: plan([step({ atMs: two, setpointC: 25, targetPct: 10 })]) }));
    expect(v.nightRecovery?.requiredHours).toBe(2);
    expect(v.nightRecovery?.status).toBe('met');
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
