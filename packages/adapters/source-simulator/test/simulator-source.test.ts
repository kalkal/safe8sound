import { ForecastSchema, SnapshotSchema, epochMs } from '@cold-reserve/contracts';
import { fixedClock } from '@cold-reserve/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SCENARIO_IDS, builtInScenario, defaultSimParams, demoProfile, type ScenarioId } from '../src/index.js';
import { SimulatorSource } from '../src/simulator-source.js';

const profile = demoProfile();
const params = defaultSimParams();
const HOUR = 3_600_000;

const source = (id: ScenarioId, over: { seed?: number; nowMs?: number } = {}) => {
  const base = builtInScenario(id);
  const scenario = over.seed === undefined ? base : { ...base, seed: over.seed };
  const start = epochMs(scenario.startAt);
  return { sim: new SimulatorSource({ profile, scenario, params, clock: fixedClock(over.nowMs ?? start) }), start, scenario };
};

describe('SimulatorSource', () => {
  it('returns a valid, fully simulated snapshot through the port', async () => {
    const { sim } = source('clear-day');
    const r = await sim.snapshot();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(SnapshotSchema.safeParse(r.value).success).toBe(true);
    expect(r.value.origin).toEqual({ energy: 'simulated', rooms: 'simulated', weather: 'simulated', scenario: 'clear-day' });
    expect(r.value.homeId).toBe(profile.homeId);
  });

  it.each(SCENARIO_IDS)('%s: every second of the scenario gives a valid snapshot', (id) => {
    const { sim, start, scenario } = source(id);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: scenario.durationH * 3600 }), (s) => {
        expect(SnapshotSchema.safeParse(sim.snapshotAt(start + s * 1000)).success).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it('the same seed gives the same series', () => {
    const a = source('heatwave').sim;
    const b = source('heatwave').sim;
    const { start } = source('heatwave');
    for (let m = 0; m < 24 * 60; m += 37) {
      expect(a.snapshotAt(start + m * 60_000)).toEqual(b.snapshotAt(start + m * 60_000));
    }
  });

  it('is reproducible to the second, whatever was asked before', () => {
    const { start } = source('clear-day');
    const t = start + 13 * HOUR + 17 * 60_000 + 41_000;
    const fresh = source('clear-day').sim.snapshotAt(t);
    const busy = source('clear-day').sim;
    busy.snapshotAt(start + 20 * HOUR);
    busy.snapshotAt(start + 2 * HOUR + 5_000);
    expect(busy.snapshotAt(t)).toEqual(fresh);
    expect(fresh.ts).toBe(new Date(t).toISOString());
    // Sub-second clock readings map to the same second.
    expect(source('clear-day').sim.snapshotAt(t + 999)).toEqual(fresh);
  });

  it('a different seed gives a different series', () => {
    const { start } = source('clear-day');
    const a = source('clear-day', { seed: 1 }).sim;
    const b = source('clear-day', { seed: 2 }).sim;
    const differs = [3, 9, 15, 21].some((h) => a.snapshotAt(start + h * HOUR).loadW !== b.snapshotAt(start + h * HOUR).loadW);
    expect(differs).toBe(true);
  });

  it('clamps readings to the scenario window', () => {
    const { sim, start, scenario } = source('clear-day');
    expect(sim.snapshotAt(start - HOUR)).toEqual(sim.snapshotAt(start));
    const end = start + scenario.durationH * HOUR;
    expect(sim.snapshotAt(end + HOUR)).toEqual(sim.snapshotAt(end));
  });

  it('reads the injected clock', async () => {
    const { start } = source('clear-day');
    const { sim } = source('clear-day', { nowMs: start + 5 * HOUR });
    const r = await sim.snapshot();
    expect(r.ok && r.value.ts).toBe(new Date(start + 5 * HOUR).toISOString());
  });

  it('clear-day: no PV at night, about 5 kW at solar noon (spike S6 PVGIS July profile)', () => {
    const { sim, start } = source('clear-day');
    expect(sim.snapshotAt(start + 2 * HOUR).pvW).toBe(0);
    const noon = sim.snapshotAt(start + 13 * HOUR).pvW;
    expect(noon).toBeGreaterThan(4000);
    expect(noon).toBeLessThanOrEqual(6000);
  });

  it('clear-day: the safe room is held at its set point while cooling', () => {
    const { sim, start } = source('clear-day');
    const safe = sim.snapshotAt(start + 15 * HOUR).rooms.find((r) => r.id === 'bedroom-1');
    expect(safe?.hvac?.mode).toBe('cool');
    expect(safe?.tempC).toBeCloseTo(safe?.hvac?.setpointC ?? NaN, 0);
  });

  it('storm-blackout: no grid flow during the outage, SOC never below the floor', () => {
    const { sim, start, scenario } = source('storm-blackout');
    const outage = scenario.gridOutages[0];
    if (!outage) throw new Error('storm-blackout has an outage');
    for (let m = 0; m <= scenario.durationH * 60; m += 10) {
      const s = sim.snapshotAt(start + m * 60_000);
      expect(s.batterySocPct).toBeGreaterThanOrEqual(profile.battery.minSocHwPct);
      const h = m / 60;
      if (h >= outage.fromH && h < outage.toH) {
        expect(s.gridAvailable).toBe(false);
        expect(s.gridW).toBe(0);
      }
      expect(s.origin).toEqual({ energy: 'simulated', rooms: 'simulated', weather: 'simulated', scenario: 'storm-blackout' });
    }
  });

  it('storm-blackout: default HVAC drains to the floor at ~06:00 before the grid returns at 06:30', () => {
    // Without pacing (F4) the battery runs out just before the grid comes back: the case that the
    // pacing_on_track guarantee must prevent.
    const { sim, start, scenario } = source('storm-blackout');
    const outage = scenario.gridOutages[0];
    if (!outage) throw new Error('storm-blackout has an outage');
    let floorAtH: number | undefined;
    for (let m = 0; m <= scenario.durationH * 60 && floorAtH === undefined; m++) {
      if (sim.snapshotAt(start + m * 60_000).batterySocPct <= profile.battery.minSocHwPct) floorAtH = m / 60;
    }
    // Scenario starts at 12:00 local: 06:00 is hour 18, 06:30 is hour 18.5.
    expect(floorAtH).toBeGreaterThanOrEqual(17.5);
    expect(floorAtH).toBeLessThan(outage.toH);
    expect(outage.toH).toBe(18.5);
    const dark = sim.snapshotAt(start + (outage.toH - 0.1) * HOUR);
    expect(dark.gridAvailable).toBe(false);
    expect(dark.loadW).toBeLessThan(200);
  });

  it('forecast: hourly scenario weather from now to the end, valid against the contract', () => {
    const { start } = source('heatwave');
    const { sim, scenario } = source('heatwave', { nowMs: start + 10 * HOUR + 1 });
    const f = sim.forecast();
    expect(ForecastSchema.safeParse(f).success).toBe(true);
    expect(f.hourly).toHaveLength(scenario.durationH - 11);
    expect(f.hourly[0]?.ts).toBe(new Date(start + 11 * HOUR).toISOString());
    expect(f.confidence).toBe('high');
  });

  it('heatwave is hotter than clear-day', () => {
    const max = (id: ScenarioId) => Math.max(...builtInScenario(id).hourly.map((h) => h.tempOutC));
    expect(max('heatwave')).toBeGreaterThan(max('clear-day'));
  });
});
