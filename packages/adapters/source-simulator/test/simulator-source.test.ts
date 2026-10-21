import { ForecastSchema, HomeProfileSchema, SnapshotSchema, epochMs } from '@cold-reserve/contracts';
import { fixedClock } from '@cold-reserve/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SCENARIO_IDS, builtInScenario, defaultSimParams, demoProfile, inputsAt, type ScenarioId } from '../src/index.js';
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

  // The Echo's top bar says the weather outside (owner, 20 Oct): the snapshot carries the scenario's own outdoor
  // temperature at that moment (inputsAt, the one source the physics reads too), rounded to 0.1 °C.
  it('carries the outdoor temperature the scenario plays at that moment', () => {
    const { sim, start, scenario } = source('heatwave');
    for (const h of [0, 6, 13]) {
      const at = start + h * HOUR;
      const expected = Math.round(inputsAt(scenario, h * 3600).outC * 10) / 10;
      expect(sim.snapshotAt(at).outdoorTempC).toBe(expected);
    }
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

  it('a simulated home without its EPS load gives no readings: missing_eps_load, never an assumed figure (#107)', async () => {
    const bare = HomeProfileSchema.parse(Object.fromEntries(Object.entries(profile).filter(([k]) => k !== 'epsBaseLoadW')));
    const scenario = builtInScenario('storm-blackout');
    const sim = new SimulatorSource({ profile: bare, scenario, params: defaultSimParams(), clock: fixedClock(Date.parse(scenario.startAt)) });
    expect(await sim.snapshot()).toMatchObject({ ok: false, error: { code: 'missing_eps_load' } });
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

  it('storm-blackout (#390): off grid only the EPS circuits draw; the safe room is held under its limits on a low battery until the grid returns, then the house is cooled again', () => {
    // Off grid only the EPS circuits are powered (#19): the profile's 150 W besides the HVAC, plus the safe room's split.
    // Until #390 the script dried the safe room at 27 °C with the fan all storm long: above the older person's 24 °C night
    // limit, and a dry mode that draws a fixed share of the input, so a low battery ran out before midnight. Now the
    // script holds the room as storm mode would: 25 °C in the evening, 24 °C (the night limit) from 21:00, the essential
    // step, on a 30 % battery that lasts until the grid returns at 06:30; then the living room is cooled again too.
    const { sim, start, scenario } = source('storm-blackout');
    const outage = scenario.gridOutages[0];
    if (!outage) throw new Error('storm-blackout has an outage');
    expect(outage.toH).toBe(18.5);
    expect(scenario.initial.batterySocPct).toBe(30);
    expect(scenario.essentialAtH).toBe(9);
    const dark = sim.snapshotAt(start + (outage.toH - 0.1) * HOUR);
    expect(dark.gridAvailable).toBe(false);
    expect(dark.batterySocPct).toBeGreaterThan(profile.battery.minSocHwPct);
    expect(dark.loadW).toBeLessThan(800);
    const safe = profile.rooms.find((r) => r.isSafeRoom);
    const most = 150 + (safe?.hvacUnits[0]?.inputKw.max ?? 0) * 1000 + (safe?.fans.reduce((w, f) => w + f.powerW, 0) ?? 0);
    expect(sim.snapshotAt(start + 8 * HOUR).loadW).toBeLessThanOrEqual(most * 1.05);
    // Within the night limit through the night, never the 27 °C of the old script.
    for (let h = 10; h < outage.toH; h += 0.5) expect(sim.snapshotAt(start + h * HOUR).rooms.find((r) => r.id === 'bedroom-1')?.tempC).toBeLessThanOrEqual(24);
    // Power back: the living room is served again, not only the safe room.
    const back = sim.snapshotAt(start + (outage.toH + 0.5) * HOUR);
    expect(back.rooms.filter((r) => r.hvac !== undefined && r.hvac.mode !== 'off').map((r) => r.id).sort()).toEqual(['bedroom-1', 'living']);
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

  it('forecast: never empty; from the last hour of the day on it keeps that hour, which the projection holds (#238)', () => {
    const { start, scenario } = source('clear-day');
    const lastHour = scenario.hourly[scenario.durationH - 1];
    for (const nowMs of [start + (scenario.durationH - 1) * HOUR + 1, start + (scenario.durationH - 0.5) * HOUR, start + scenario.durationH * HOUR, start + (scenario.durationH + 5) * HOUR]) {
      const f = source('clear-day', { nowMs }).sim.forecast();
      expect(ForecastSchema.safeParse(f).success).toBe(true);
      expect(f.hourly).toHaveLength(1);
      expect(f.hourly[0]).toMatchObject({ ts: new Date(start + (scenario.durationH - 1) * HOUR).toISOString(), tempOutC: lastHour?.tempOutC });
    }
    // Before the last hour nothing changes: from the next whole hour to the end.
    expect(source('clear-day', { nowMs: start + (scenario.durationH - 2) * HOUR + 1 }).sim.forecast().hourly).toHaveLength(1);
    expect(source('clear-day', { nowMs: start + (scenario.durationH - 3) * HOUR + 1 }).sim.forecast().hourly).toHaveLength(2);
  });

  it('heatwave is hotter than clear-day', () => {
    const max = (id: ScenarioId) => Math.max(...builtInScenario(id).hourly.map((h) => h.tempOutC));
    expect(max('heatwave')).toBeGreaterThan(max('clear-day'));
  });
});
