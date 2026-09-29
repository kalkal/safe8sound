import { HomeProfileSchema, celsius, minutes, pct, watt, type HvacMode } from '@cold-reserve/contracts';
import { exampleHomeProfile } from '@cold-reserve/contracts/fixtures';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { stepHome, type HomeInputs, type HomeState, type SimParams } from '../src/simulation.js';

const profile = HomeProfileSchema.parse(exampleHomeProfile());

// Values from spike S6 (the simulator package keeps them in its config file).
const params: SimParams = {
  hvac: { dryInputFactor: 0.5, drySensibleFactor: 0.3, fanOnlyInputW: 30 },
  gains: { perRoomBaseW: 50, perOccupantW: 80 },
  solarApertureM2: { default: 0.8, byRoom: {} },
  humidity: { exchangeTimeConstantH: 3, coolRemovalPctPerH: 4, dryRemovalPctPerH: 5 },
  pv: { lossRatio: 0.14 },
  load: { noiseRatio: 0.05 },
};

const state = (soc = 50, tempC = 28): HomeState => ({
  socPct: pct(soc),
  rooms: profile.rooms.map((r) => ({ id: r.id, tempC: celsius(tempC), humidityPct: pct(55) })),
});

const inputs = (over: Partial<HomeInputs> = {}): HomeInputs => ({
  outC: celsius(33),
  outRhPct: pct(40),
  irradianceWm2: 700,
  baseLoadW: watt(400),
  gridAvailable: true,
  rooms: [{ id: 'bedroom-1', occupants: ['grandpa'], hvac: { mode: 'cool', setpointC: celsius(26) }, fanOn: true }],
  ...over,
});

const room = (s: HomeState, id: string) => s.rooms.find((r) => r.id === id);

describe('stepHome', () => {
  it('is deterministic', () => {
    const args = { state: state(), inputs: inputs(), profile, params, dt: minutes(1), noise: 0.3 };
    expect(stepHome(args)).toEqual(stepHome(args));
  });

  it('cools a room in cool mode down to its set point', () => {
    let s = state(80, 28);
    for (let i = 0; i < 120; i++) s = stepHome({ state: s, inputs: inputs(), profile, params, dt: minutes(1), noise: 0.5 }).state;
    expect(room(s, 'bedroom-1')?.tempC).toBeCloseTo(26, 6);
    // A room without HVAC drifts with the weather.
    expect(room(s, 'living')?.tempC).toBeGreaterThan(28);
  });

  it('counts HVAC and fan power in the house load', () => {
    const step = stepHome({ state: state(), inputs: inputs(), profile, params, dt: minutes(1), noise: 0.5 });
    expect(step.flows.hvacW).toBeGreaterThan(0);
    expect(step.flows.fansW).toBe(45);
    expect(step.flows.loadW).toBeCloseTo(400 + step.flows.hvacW + 45, 6);
  });

  it('applies seeded noise to the base load within the configured ratio', () => {
    const off = inputs({ rooms: [] });
    const low = stepHome({ state: state(), inputs: off, profile, params, dt: minutes(1), noise: 0 });
    const high = stepHome({ state: state(), inputs: off, profile, params, dt: minutes(1), noise: 0.999_999 });
    expect(low.flows.loadW).toBeCloseTo(400 * 0.95, 6);
    expect(high.flows.loadW).toBeCloseTo(400 * 1.05, 3);
  });

  it('off grid with an empty battery the HVAC gets no power and the room warms', () => {
    const night = inputs({ irradianceWm2: 0, gridAvailable: false });
    const served = stepHome({ state: state(80, 28), inputs: night, profile, params, dt: minutes(10), noise: 0.5 });
    const dark = stepHome({ state: state(10, 28), inputs: night, profile, params, dt: minutes(10), noise: 0.5 });
    expect(dark.flows.unservedLoadW).toBeGreaterThan(0);
    expect(room(dark.state, 'bedroom-1')?.tempC).toBeGreaterThan(room(served.state, 'bedroom-1')?.tempC ?? Infinity);
  });

  it('occupants warm a room', () => {
    const empty = inputs({ rooms: [{ id: 'study', occupants: [], fanOn: false }] });
    const busy = inputs({ rooms: [{ id: 'study', occupants: ['a', 'b', 'c'], fanOn: false }] });
    const a = stepHome({ state: state(), inputs: empty, profile, params, dt: minutes(30), noise: 0.5 });
    const b = stepHome({ state: state(), inputs: busy, profile, params, dt: minutes(30), noise: 0.5 });
    expect(room(b.state, 'study')?.tempC).toBeGreaterThan(room(a.state, 'study')?.tempC ?? Infinity);
  });

  it('dry mode lowers the humidity faster than doing nothing', () => {
    const dry = inputs({ rooms: [{ id: 'bedroom-1', occupants: [], hvac: { mode: 'dry', setpointC: celsius(24) }, fanOn: false }] });
    const none = inputs({ rooms: [] });
    const a = stepHome({ state: state(), inputs: dry, profile, params, dt: minutes(30), noise: 0.5 });
    const b = stepHome({ state: state(), inputs: none, profile, params, dt: minutes(30), noise: 0.5 });
    expect(room(a.state, 'bedroom-1')?.humidityPct).toBeLessThan(room(b.state, 'bedroom-1')?.humidityPct ?? -Infinity);
  });

  it('rejects a state that does not match the profile (a programming error)', () => {
    const bad: HomeState = { socPct: pct(50), rooms: [{ id: 'garage', tempC: celsius(25), humidityPct: pct(50) }] };
    expect(() => stepHome({ state: bad, inputs: inputs(), profile, params, dt: minutes(1), noise: 0.5 })).toThrow(/garage/);
  });

  it('property: SOC in range and energy balance hold over random days', () => {
    const modes: HvacMode[] = ['cool', 'heat', 'dry', 'fan_only', 'auto', 'off'];
    const stepArb = fc.record({
      out: fc.double({ min: 15, max: 42, noNaN: true }),
      rh: fc.double({ min: 10, max: 100, noNaN: true }),
      sun: fc.double({ min: 0, max: 1000, noNaN: true }),
      base: fc.double({ min: 0, max: 3000, noNaN: true }),
      grid: fc.boolean(),
      mode: fc.constantFrom(...modes),
      sp: fc.double({ min: 18, max: 30, noNaN: true }),
      noise: fc.double({ min: 0, max: 0.999, noNaN: true }),
    });
    fc.assert(
      fc.property(fc.double({ min: 10, max: 100, noNaN: true }), fc.array(stepArb, { minLength: 1, maxLength: 60 }), (soc0, steps) => {
        let s = state(soc0, 27);
        for (const x of steps) {
          const i = inputs({
            outC: celsius(x.out),
            outRhPct: pct(x.rh),
            irradianceWm2: x.sun,
            baseLoadW: watt(x.base),
            gridAvailable: x.grid,
            rooms: profile.rooms.map((r) => ({ id: r.id, occupants: ['a'], hvac: { mode: x.mode, setpointC: celsius(x.sp) }, fanOn: true })),
          });
          const { state: next, flows } = stepHome({ state: s, inputs: i, profile, params, dt: minutes(5), noise: x.noise });
          expect(next.socPct).toBeGreaterThanOrEqual(10);
          expect(next.socPct).toBeLessThanOrEqual(100);
          expect(flows.pvUsedW + flows.gridImportW + flows.dischargeW).toBeCloseTo(flows.servedLoadW + flows.chargeW + flows.gridExportW, 6);
          for (const r of next.rooms) {
            expect(r.humidityPct).toBeGreaterThanOrEqual(0);
            expect(r.humidityPct).toBeLessThanOrEqual(100);
          }
          s = next;
        }
      }),
    );
  });
});
