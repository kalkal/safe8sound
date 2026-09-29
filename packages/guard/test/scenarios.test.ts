import { GUARANTEE_IDS, PreferencesSchema, type HvacMode } from '@cold-reserve/contracts';
import { examplePreferences } from '@cold-reserve/contracts/fixtures';
import { fixedClock } from '@cold-reserve/core';
import { SimulatorSource, builtInScenario, defaultSimParams, demoProfile, type ScenarioId } from '@cold-reserve/source-simulator';
import { describe, expect, it } from 'vitest';
import { rejectionOf, runGuard, type GuardVerdict } from '../src/index.js';
import { LADDER, config, iso, step } from './support.js';

// The guard on the seeded simulator scenarios (F1): same physics, fixed seeds.

const H = 3_600_000;
const profile = demoProfile();
const preferences = PreferencesSchema.parse({ ...examplePreferences(), roomPriority: ['bedroom-1', 'bedroom-2', 'living', 'study'] });

function verdictAt(id: ScenarioId, atH: number, s: { mode: HvacMode; setpointC: number; fanOn: boolean; targetPct: number }): GuardVerdict {
  const scenario = builtInScenario(id);
  const startMs = Date.parse(scenario.startAt);
  const nowMs = startMs + atH * H;
  const sim = new SimulatorSource({ profile, scenario, params: defaultSimParams(), clock: fixedClock(nowMs) });
  return runGuard({
    plan: { horizonAt: iso(nowMs + 12 * H), steps: [step({ atMs: nowMs, ...s })], ladder: LADDER },
    snapshot: sim.snapshotAt(nowMs),
    forecast: sim.forecast(),
    profile,
    preferences,
    season: 'cooling',
    model: defaultSimParams(),
    config: config(),
    nightRecoveryMode: 'standard',
  });
}

const byId = (v: GuardVerdict, id: string) => v.guarantees.find((g) => g.id === id);

describe('storm-blackout: the grid goes down at 15:00 and returns at 06:30', () => {
  // The scenario's own HVAC (dry 27 °C + fan) drains the battery at about 04:00 in the simulator, before
  // the grid is back at 06:30: the case pacing_on_track exists to refuse.
  const naive = verdictAt('storm-blackout', 3, { mode: 'dry', setpointC: 27, fanOn: true, targetPct: 10 });

  it('refuses the naive plan: the battery runs out before the next recharge', () => {
    const pacing = byId(naive, 'pacing_on_track');
    expect(pacing?.ok).toBe(false);
    expect(pacing?.unit).toBe('min');
    expect(pacing?.measured).toBeGreaterThan(0);
    expect(pacing?.reason).toMatch(/runs out at 0[3-7]:\d\d, \d+ min before the next recharge at 08:00/);
    expect(naive.ok).toBe(false);
  });

  it('with the grid down, the reserve is the budget and the inverter limit is the EPS rating', () => {
    expect(byId(naive, 'storm_reserve')?.ok).toBe(true);
    expect(byId(naive, 'inverter_limit')).toMatchObject({ ok: true, limit: profile.eps.continuousVa });
  });

  it('lists all five guarantees and explains the rejection', () => {
    expect(naive.guarantees.map((g) => g.id)).toEqual([...GUARANTEE_IDS]);
    expect(rejectionOf(naive)?.category).toBe('guard_rejection');
  });
});

describe('heatwave: 38 °C in the afternoon, grid up', () => {
  const v = verdictAt('heatwave', 14, { mode: 'cool', setpointC: 26, fanOn: true, targetPct: 60 });

  it('keeps the storm reserve and the inverter limit for a single cooled room', () => {
    expect(byId(v, 'storm_reserve')?.ok).toBe(true);
    expect(byId(v, 'inverter_limit')?.ok).toBe(true);
    expect(byId(v, 'battery_power')?.ok).toBe(true);
    expect(v.reserveFloorSocPct).toBeGreaterThan(profile.battery.minSocHwPct);
  });

  it('refuses a target under the reserve floor', () => {
    const low = verdictAt('heatwave', 14, { mode: 'cool', setpointC: 26, fanOn: true, targetPct: 20 });
    expect(byId(low, 'storm_reserve')?.ok).toBe(false);
    expect(rejectionOf(low)?.code).toBe('storm_reserve_violated');
  });

  it('evaluates the night of the safe room', () => {
    expect(v.nightRecovery?.roomId).toBe('bedroom-1');
    expect(v.nightRecovery?.window.start).toBe('2026-07-16T20:00:00.000Z');
  });
});
