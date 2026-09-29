import { ForecastSchema, SnapshotSchema, celsius } from '@cold-reserve/contracts';
import { indoorEquilibriumRh, weatherFromForecast } from '@cold-reserve/core';
import { describe, expect, it } from 'vitest';
import { buildContext, currentControls, projectFrom } from '../src/context.js';
import { H, MIN, T0, config, hotNight, input, iso, plan, snapshot, step } from './support.js';

describe('currentControls', () => {
  it('copies what the snapshot says each room is doing; no fan reading means off', () => {
    const s = SnapshotSchema.parse({
      ...snapshot(),
      rooms: [
        { id: 'bedroom-1', tempC: 26, occupants: [], hvac: { mode: 'dry', setpointC: 26, preset: 'eco' }, fanOn: true },
        { id: 'living', tempC: 27, occupants: [] },
      ],
    });
    expect(currentControls(s)).toEqual([
      { id: 'bedroom-1', hvac: { mode: 'dry', setpointC: 26 }, fanOn: true },
      { id: 'living', fanOn: false },
    ]);
  });
});

describe('buildContext', () => {
  it('sorts the battery targets and keeps the lowest one per time', () => {
    const steps = [step({ atMs: T0 + H, targetPct: 70 }), step({ atMs: T0, targetPct: 80 }), step({ atMs: T0 + H, roomId: 'living', targetPct: 65 })];
    expect(buildContext(input({ plan: plan(steps) })).targets).toEqual([
      { ms: T0, pct: 80 },
      { ms: T0 + H, pct: 65 },
    ]);
  });

  it('extends the horizon to the next recharge, and to at least one step', () => {
    expect(buildContext(input({ plan: plan([step({})], T0 + H) })).horizonMs).toBe(Date.parse('2026-07-16T07:00:00+02:00'));
    const bright = ForecastSchema.parse({ ...hotNight(), hourly: hotNight().hourly.map((h) => ({ ...h, irradianceWm2: 800 })) });
    expect(buildContext(input({ forecast: bright, plan: plan([step({})], T0 - H) })).horizonMs).toBe(T0 + config().projection.stepMinutes * MIN);
  });

  it('keeps the whole cap as reserve when the forecast shows no recharge', () => {
    const dark = ForecastSchema.parse({ ...hotNight(), hourly: hotNight().hourly.map((h) => ({ ...h, irradianceWm2: 0 })) });
    expect(buildContext(input({ forecast: dark })).reserveWh).toBe(config().reserve.capWh);
  });

  it('stops the projected battery at the reserve floor on grid and at the hardware floor off grid', () => {
    const on = buildContext(input());
    expect(on.dischargeFloorPct).toBe(on.reserveFloorSocPct);
    expect(buildContext(input({ snapshot: snapshot({ gridAvailable: false }) })).dischargeFloorPct).toBe(10);
  });
});

describe('projectFrom', () => {
  it('projects only the rooms the home profile knows, and fills a missing humidity from the outdoor air', () => {
    const s = SnapshotSchema.parse({
      ...snapshot(),
      rooms: [
        { id: 'bedroom-1', tempC: 28, occupants: [] },
        { id: 'garage', tempC: 35, humidityPct: 40, occupants: [] },
      ],
    });
    const i = input({ snapshot: s });
    const points = projectFrom(i, () => [{ id: 'garage', fanOn: true }, { id: 'bedroom-1', fanOn: false }], { toMs: T0 + H, dischargeFloorPct: s.batterySocPct });
    expect(points[0]?.rooms.map((r) => r.id)).toEqual(['bedroom-1']);
    const now = weatherFromForecast(hotNight())(T0);
    expect(points[0]?.rooms[0]?.humidityPct).toBeCloseTo(indoorEquilibriumRh({ outC: now.outC, outRhPct: now.outRhPct, inC: celsius(28) }), 9);
    expect(points[0]?.flows.fansW).toBe(0);
    expect(iso(points.at(-1)?.ms ?? 0)).toBe(iso(T0 + H - 5 * MIN));
  });
});
