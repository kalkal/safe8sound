import { ForecastSchema, HomeProfileSchema, celsius, pct, type PlanStep } from '@cold-reserve/contracts';
import { exampleForecast, exampleHomeProfile } from '@cold-reserve/contracts/fixtures';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { controlFromSteps, project, weatherFromForecast, type ProjectionInput, type RoomControl } from '../src/projection.js';
import type { SimParams } from '../src/simulation.js';

// Mutation testing runs the properties with fewer cases (FC_RUNS); CI and local runs use the full count.
const runs = (n: number): number => Number(process.env['FC_RUNS'] ?? n);

const profile = HomeProfileSchema.parse(exampleHomeProfile());
const params: SimParams = {
  hvac: { dryInputFactor: 0.5, drySensibleFactor: 0.3, fanOnlyInputW: 30 },
  gains: { perRoomBaseW: 50, perOccupantW: 80 },
  solarApertureM2: { default: 0.3, byRoom: {} },
  humidity: {
    exchangeTimeConstantH: 3,
    roomVolumeM3: { default: 35, byRoom: {} },
    occupantGainGph: 60,
    baseGainGph: 30,
    removalLphPerCoolingKw: 0.33,
    dryRemovalFactor: 0.6,
    rating: { tempC: 27, rhPct: 47 },
    coilDewpointC: 8,
  },
  pv: { lossRatio: 0.14 },
  load: { noiseRatio: 0.05 },
};
const H = 3_600_000;
const T0 = Date.parse('2026-07-15T20:00:00+02:00');

const night = ForecastSchema.parse({
  ...exampleForecast(),
  hourly: Array.from({ length: 12 }, (_, i) => ({
    ts: new Date(T0 + i * H).toISOString(),
    tempOutC: 30 - i,
    humidityOutPct: 50,
    irradianceWm2: 0,
    stormProb: 0,
  })),
});

const cool = (id: string, setpointC = 25): RoomControl => ({ id, hvac: { mode: 'cool', setpointC: celsius(setpointC) }, fanOn: false });
const off = (id: string): RoomControl => ({ id, fanOn: false });

const base = (over: Partial<ProjectionInput> = {}): ProjectionInput => ({
  profile,
  params,
  start: {
    ms: T0,
    socPct: pct(80),
    rooms: profile.rooms.map((r) => ({ id: r.id, tempC: celsius(29), humidityPct: pct(55) })),
    occupants: { 'bedroom-1': ['grandpa'] },
  },
  weatherAt: weatherFromForecast(night),
  controlAt: () => [cool('bedroom-1'), off('living'), off('study')],
  gridAvailable: false,
  dischargeFloorPct: pct(profile.battery.minSocHwPct),
  baseLoadAt: () => 300,
  toMs: T0 + 6 * H,
  stepMinutes: 5,
  ...over,
});

describe('weatherFromForecast', () => {
  const w = weatherFromForecast(night);

  it('interpolates linearly inside the hour', () => {
    expect(w(T0 + H / 2).outC).toBeCloseTo(29.5, 9);
  });

  it('does not depend on the order of the hours', () => {
    const reversed = weatherFromForecast({ ...night, hourly: [...night.hourly].reverse() });
    expect(reversed(T0 + H / 2).outC).toBeCloseTo(29.5, 9);
  });

  it('refuses a forecast without hours', () => {
    expect(() => weatherFromForecast({ ...night, hourly: [] })(T0)).toThrow('The forecast has no hours');
  });

  it('holds the first and last values outside the forecast', () => {
    expect(w(T0 - H).outC).toBe(30);
    expect(w(T0 + 100 * H).outC).toBe(19);
  });
});

describe('controlFromSteps', () => {
  const step = (h: number, roomId: string, setpointC: number): PlanStep => ({
    ts: new Date(T0 + h * H).toISOString(),
    roomId,
    hvacMode: 'cool',
    setpointC: celsius(setpointC),
    fanOn: true,
    level: 'comfort',
    batteryTargetSocPct: pct(70),
  });
  const control = controlFromSteps([step(2, 'bedroom-1', 26), step(1, 'bedroom-1', 25)], [off('bedroom-1'), cool('living', 24)]);
  const bedroom = (ms: number) => control(ms).find((c) => c.id === 'bedroom-1');

  it('keeps the current settings until the first step of a room', () => {
    expect(bedroom(T0)).toEqual(off('bedroom-1'));
    expect(control(T0 + 5 * H).find((c) => c.id === 'living')).toEqual(cool('living', 24));
  });

  it('leaves a room that only appears in the steps off before its first step', () => {
    const only = controlFromSteps([step(1, 'study', 24)], []);
    expect(only(T0)).toEqual([{ id: 'study', fanOn: false }]);
    expect(only(T0 + H)[0]?.hvac?.setpointC).toBe(24);
  });

  it('applies the latest step at or before the time, whatever the order of the steps', () => {
    expect(bedroom(T0 + H)?.hvac?.setpointC).toBe(25);
    expect(bedroom(T0 + 2 * H - 1)?.hvac?.setpointC).toBe(25);
    expect(bedroom(T0 + 2 * H)).toEqual({ id: 'bedroom-1', hvac: { mode: 'cool', setpointC: 26 }, fanOn: true });
  });
});

describe('project', () => {
  it('gives one point per step from the start to the end, with the state at the start of each step', () => {
    const points = project(base());
    expect(points).toHaveLength(72);
    expect(points[0]?.ms).toBe(T0);
    expect(points[0]?.socPct).toBe(80);
    expect(points.at(-1)?.ms).toBe(T0 + 6 * H - 5 * 60_000);
  });

  it('is deterministic', () => {
    expect(project(base())).toEqual(project(base()));
  });

  it('cools the room the plan cools and drains the battery off grid', () => {
    const points = project(base());
    const last = points.at(-1);
    expect(last?.rooms.find((r) => r.id === 'bedroom-1')?.tempC).toBeLessThan(26);
    expect(last?.rooms.find((r) => r.id === 'living')?.tempC).toBeGreaterThan(26);
    expect(last?.socPct).toBeLessThan(80);
  });

  it('gives no occupant gains to a room without occupants', () => {
    const empty = project(base({ start: { ...base().start, occupants: {} } }));
    const listed = project(base({ start: { ...base().start, occupants: { 'bedroom-1': [], living: [], study: [] } } }));
    expect(empty).toEqual(listed);
    const occupied = project(base({ start: { ...base().start, occupants: { living: ['guest'] } } }));
    expect(occupied.at(-1)?.rooms.find((r) => r.id === 'living')?.tempC).toBeGreaterThan(empty.at(-1)?.rooms.find((r) => r.id === 'living')?.tempC ?? Infinity);
  });

  it('never discharges below the given floor', () => {
    const points = project(base({ dischargeFloorPct: pct(75), toMs: T0 + 10 * H }));
    expect(Math.min(...points.map((p) => p.socPct))).toBeGreaterThanOrEqual(75 - 1e-9);
  });

  it('property: more starting charge never leaves the room warmer, at any step (off grid)', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(profile.battery.minSocHwPct, 100), fc.double({ min: 10, max: 100, noNaN: true })),
        fc.double({ min: 0, max: 30, noNaN: true }),
        fc.double({ min: 22, max: 28, noNaN: true }),
        (soc, extra, setpoint) => {
          const run = (s: number) =>
            project(base({ start: { ...base().start, socPct: pct(Math.min(100, s)) }, controlAt: () => [cool('bedroom-1', setpoint)], toMs: T0 + 3 * H, stepMinutes: 15 }));
          const lo = run(soc);
          const hi = run(soc + extra);
          lo.forEach((p, i) => {
            const tLo = p.rooms[0]?.tempC ?? 0;
            const tHi = hi[i]?.rooms[0]?.tempC ?? 0;
            expect(tHi).toBeLessThanOrEqual(tLo + 1e-9);
          });
        },
      ),
      { numRuns: runs(10_000) },
    );
  }, 120_000);
});
