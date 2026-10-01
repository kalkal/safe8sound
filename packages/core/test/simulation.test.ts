import { HomeProfileSchema, celsius, minutes, pct, watt, type HvacMode } from '@cold-reserve/contracts';
import { exampleHomeProfile } from '@cold-reserve/contracts/fixtures';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { saturationVaporPressureHpa } from '../src/humidity.js';
import { epsBaseLoadW, stepHome, type HomeInputs, type HomeState, type RoomInputs, type SimParams } from '../src/simulation.js';

const profile = HomeProfileSchema.parse(exampleHomeProfile());

// Values from spike S6 (the simulator package keeps them in its config file).
const params: SimParams = {
  hvac: { dryInputFactor: 0.5, drySensibleFactor: 0.3, fanOnlyInputW: 30 },
  gains: { perRoomBaseW: 50, perOccupantW: 80 },
  solarApertureM2: { default: 0.8, byRoom: {} },
  humidity: {
    exchangeTimeConstantH: 3,
    roomVolumeM3: { default: 35, byRoom: {} },
    occupantGainGph: 60,
    baseGainGph: 30,
    removalLphPerCoolingKw: 0.33,
    dryRemovalFactor: 0.6,
    rating: { tempC: 27, rhPct: 47 },
    coilDewpointC: 8,
    maxLatentShare: 0.5,
  },
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

  describe('humidity wiring', () => {
    const rh = (step: ReturnType<typeof stepHome>, id: string) => room(step.state, id)?.humidityPct ?? NaN;
    const run = (over: Partial<HomeInputs>, st = state(), p: SimParams = params) => stepHome({ state: st, inputs: inputs(over), profile, params: p, dt: minutes(30), noise: 0.5 });
    const at = (tempC: number) => ({ socPct: pct(50), rooms: profile.rooms.map((r) => ({ id: r.id, tempC: celsius(tempC), humidityPct: pct(65) })) });

    it('dry dehumidifies at its set point, where cool at light load removes little', () => {
      // A mild evening, the room already at 25 °C: cool at 25 has nothing to do, dry keeps its compressor running.
      const mild = { outC: celsius(24), irradianceWm2: 0 };
      const cool = run({ ...mild, rooms: [{ id: 'bedroom-1', occupants: [], hvac: { mode: 'cool', setpointC: celsius(25) }, fanOn: false }] }, at(25));
      const dry = run({ ...mild, rooms: [{ id: 'bedroom-1', occupants: [], hvac: { mode: 'dry', setpointC: celsius(25) }, fanOn: false }] }, at(25));
      expect(rh(dry, 'bedroom-1')).toBeLessThan(rh(cool, 'bedroom-1') - 5);
    });

    it('removes nothing when nothing is served: off grid with an empty battery and no sun', () => {
      const empty = { ...state(), socPct: pct(profile.battery.minSocHwPct) };
      const dark = { irradianceWm2: 0, gridAvailable: false };
      const drying = run({ ...dark, rooms: [{ id: 'bedroom-1', occupants: [], hvac: { mode: 'dry', setpointC: celsius(24) }, fanOn: false }] }, empty);
      const idle = run({ ...dark, rooms: [] }, empty);
      expect(drying.flows.servedLoadW).toBe(0);
      expect(rh(drying, 'bedroom-1')).toBeCloseTo(rh(idle, 'bedroom-1'), 9);
    });

    it('in very humid air the removal reaches the latent cap: 0.5 × cooling in use / 0.68 Wh/g', () => {
      // Bedroom at 25 °C and 90 % RH, dry mode (share 0.6 of the 3.2 kW rated), grid up, 3.6 seconds.
      const humid = { socPct: pct(50), rooms: profile.rooms.map((r) => ({ id: r.id, tempC: celsius(25), humidityPct: pct(90) })) };
      const drying = { outC: celsius(25), outRhPct: pct(90), irradianceWm2: 0, rooms: [{ id: 'bedroom-1', occupants: [], hvac: { mode: 'dry' as const, setpointC: celsius(25) }, fanOn: false }] };
      const step = (maxLatentShare: number) =>
        stepHome({ state: humid, inputs: inputs(drying), profile, params: { ...params, humidity: { ...params.humidity, baseGainGph: 0, maxLatentShare } }, dt: minutes(0.06), noise: 0.5 });
      const gramsPerPct = ((saturationVaporPressureHpa(celsius(25)) * 100 * 35) / (461.5 * 298.15) / 100) * 1000;
      const removedGph = (s: ReturnType<typeof stepHome>) => ((90 - rh(s, 'bedroom-1')) * gramsPerPct) / 0.001;
      const cap = (3200 * 0.5 * 0.6) / (2450 / 3600);
      expect(removedGph(step(0.5))).toBeCloseTo(cap, -2);
      expect(removedGph(step(10))).toBeGreaterThan(cap * 1.2);
    });

    it('a larger room (living, 70 m³) changes humidity more slowly than a 35 m³ one', () => {
      const drying = { rooms: [{ id: 'living', occupants: [], hvac: { mode: 'dry' as const, setpointC: celsius(24) }, fanOn: false }] };
      const small = run(drying, state(), { ...params, humidity: { ...params.humidity, roomVolumeM3: { default: 35, byRoom: {} } } });
      const large = run(drying, state(), { ...params, humidity: { ...params.humidity, roomVolumeM3: { default: 35, byRoom: { living: 70 } } } });
      expect(55 - rh(large, 'living')).toBeLessThan(55 - rh(small, 'living'));
      expect(55 - rh(large, 'living')).toBeGreaterThan(0);
    });
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

describe('off grid only the EPS circuits are powered', () => {
  // A dark hour, so no PV: every watt is load. Mean noise, so the base load is exact.
  const dark = (over: Partial<HomeInputs> = {}) => inputs({ irradianceWm2: 0, baseLoadW: watt(700), ...over });
  const step = (p: typeof profile, i: HomeInputs) => stepHome({ state: state(80, 28), inputs: i, profile: p, params, dt: minutes(5), noise: 0.5 }).flows;
  const withEps = HomeProfileSchema.parse({ ...exampleHomeProfile(), epsBaseLoadW: 150 });
  const everyRoom: RoomInputs[] = ['bedroom-1', 'living', 'study'].map((id) => ({ id, occupants: [], hvac: { mode: 'cool', setpointC: celsius(24) }, fanOn: true }));

  it('on grid the whole house draws: the base load of the hour and every room', () => {
    const f = step(withEps, dark({ rooms: everyRoom }));
    expect(f.loadW - f.hvacW - f.fansW).toBeCloseTo(700, 9);
    expect(f.hvacW).toBeGreaterThan(0);
  });

  it('off grid the base load is the EPS load of the profile, whatever the hour asks', () => {
    const f = step(withEps, dark({ gridAvailable: false, rooms: [] }));
    expect(f.loadW).toBeCloseTo(150, 9);
  });

  it('off grid only the safe room runs its unit and its fans', () => {
    const f = step(withEps, dark({ gridAvailable: false, rooms: everyRoom }));
    const safeOnly = step(withEps, dark({ gridAvailable: false, rooms: everyRoom.filter((r) => r.id === 'bedroom-1') }));
    expect(f.hvacW).toBeCloseTo(safeOnly.hvacW, 9);
    expect(f.fansW).toBeCloseTo(safeOnly.fansW, 9);
    expect(f.hvacW).toBeGreaterThan(0);
  });

  it('without the EPS load in the profile it is missing, and off grid the whole house is drawn: never an assumed number', () => {
    const bare = HomeProfileSchema.parse(Object.fromEntries(Object.entries(exampleHomeProfile()).filter(([k]) => k !== 'epsBaseLoadW')));
    expect(epsBaseLoadW(withEps)).toEqual({ ok: true, value: 150 });
    expect(epsBaseLoadW(bare)).toMatchObject({ ok: false, error: { code: 'missing_eps_load' } });
    // The pessimistic bound: the hour's whole-house base load, as if every circuit stayed powered.
    expect(step(bare, dark({ gridAvailable: false, rooms: [] })).loadW).toBeCloseTo(700, 9);
  });
});
