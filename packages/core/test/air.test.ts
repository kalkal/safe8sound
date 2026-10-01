import { celsius, minutes, pct, watt } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { feelsLikeC } from '../src/comfort.js';
import { indoorEquilibriumRh, saturationVaporPressureHpa, stepRoomMoisture } from '../src/humidity.js';
import { pvPowerW } from '../src/pv.js';

describe('humidity', () => {
  it('saturation vapour pressure matches reference values (Magnus)', () => {
    expect(saturationVaporPressureHpa(celsius(0))).toBeCloseTo(6.11, 1);
    expect(saturationVaporPressureHpa(celsius(20))).toBeCloseTo(23.4, 0);
    expect(saturationVaporPressureHpa(celsius(30))).toBeCloseTo(42.4, 0);
  });

  it('outdoor air brought to a cooler room has a higher relative humidity', () => {
    const rh = indoorEquilibriumRh({ outC: celsius(33), outRhPct: pct(40), inC: celsius(26) });
    expect(rh).toBeGreaterThan(55);
    expect(rh).toBeLessThan(65);
  });

  it('caps the equilibrium at 100 %', () => {
    expect(indoorEquilibriumRh({ outC: celsius(30), outRhPct: pct(95), inC: celsius(20) })).toBe(100);
  });

});

describe('stepRoomMoisture: water balance of the room air', () => {
  // A 35 m³ bedroom at 26 °C in a humid evening (28 °C, 70 % outside).
  const base = {
    rhPct: pct(60),
    tempC: celsius(26),
    nextTempC: celsius(26),
    outC: celsius(28),
    outRhPct: pct(70),
    dt: minutes(60),
    volumeM3: 35,
    exchangeTimeConstantH: 3,
    gainsGph: 0,
    removalGph: 0,
    rating: { tempC: 27, rhPct: 47 },
    coilDewpointC: 8,
    maxRemovalGph: 1e9,
  };

  it('with no gains and no removal relaxes toward the outdoor water vapour at room temperature', () => {
    const eq = indoorEquilibriumRh({ outC: base.outC, outRhPct: base.outRhPct, inC: base.tempC });
    const next = stepRoomMoisture(base);
    expect(next).toBeGreaterThan(60);
    expect(next).toBeLessThan(eq);
    expect(stepRoomMoisture({ ...base, dt: minutes(6000) })).toBeCloseTo(eq, 6);
  });

  it('keeps the water when the room cools: the relative humidity rises', () => {
    expect(stepRoomMoisture({ ...base, dt: minutes(0.001), nextTempC: celsius(24) })).toBeGreaterThan(60);
  });

  it('a 1 l/h split at full duty dries a humid room within the hour (datasheet order of magnitude)', () => {
    const next = stepRoomMoisture({ ...base, rhPct: pct(80), removalGph: 1000 });
    expect(next).toBeLessThan(60);
  });

  it('removes the datasheet capacity at the rating condition (27 °C, 47 %), with no gains or exchange', () => {
    // 35 m³ at 27 °C: 1 % RH is about 9 g of water. Over 3.6 s the rate is the initial one: 1.2 l/h.
    const hours = 0.001;
    const next = stepRoomMoisture({ ...base, rhPct: pct(47), tempC: celsius(27), nextTempC: celsius(27), outRhPct: pct(47), outC: celsius(27), removalGph: 1200, dt: minutes(hours * 60), exchangeTimeConstantH: 1e9 });
    const gramsPerPct = ((saturationVaporPressureHpa(celsius(27)) * 100 * 35) / (461.5 * 300.15) / 100) * 1000;
    expect(((47 - next) * gramsPerPct) / hours).toBeCloseTo(1200, -1);
  });

  it('caps the removal in very humid air at the latent limit', () => {
    const humid = { ...base, rhPct: pct(95), removalGph: 1200, dt: minutes(0.06), exchangeTimeConstantH: 1e9, outRhPct: pct(95) };
    const gramsPerPct = ((saturationVaporPressureHpa(celsius(26)) * 100 * 35) / (461.5 * 299.15) / 100) * 1000;
    const rate = (next: number) => ((95 - next) * gramsPerPct) / 0.001;
    expect(rate(stepRoomMoisture({ ...humid, maxRemovalGph: 1e9 }))).toBeGreaterThan(2000);
    expect(rate(stepRoomMoisture({ ...humid, maxRemovalGph: 1500 }))).toBeCloseTo(1500, -2);
  });

  it('occupants add water: about 60 g/h per person (CIBSE Guide A order of magnitude)', () => {
    expect(stepRoomMoisture({ ...base, gainsGph: 120 })).toBeGreaterThan(stepRoomMoisture(base));
  });

  it('never dries the air below the coil dew point, however large the removal', () => {
    const floor = (saturationVaporPressureHpa(celsius(8)) / saturationVaporPressureHpa(celsius(26))) * 100;
    const next = stepRoomMoisture({ ...base, removalGph: 1e7, dt: minutes(600) });
    expect(next).toBeGreaterThanOrEqual(floor - 1e-6);
    expect(next).toBeLessThan(floor + 1);
  });

  const inputs = fc.record({
    rh: fc.double({ min: 0, max: 100, noNaN: true }),
    t: fc.double({ min: 10, max: 40, noNaN: true }),
    t2: fc.double({ min: 10, max: 40, noNaN: true }),
    out: fc.double({ min: 0, max: 45, noNaN: true }),
    outRh: fc.double({ min: 0, max: 100, noNaN: true }),
    dt: fc.double({ min: 0.1, max: 600, noNaN: true }),
    gains: fc.double({ min: 0, max: 1000, noNaN: true }),
    removal: fc.double({ min: 0, max: 5000, noNaN: true }),
  });
  const step = (x: { rh: number; t: number; t2: number; out: number; outRh: number; dt: number; gains: number; removal: number }) =>
    stepRoomMoisture({
      ...base,
      rhPct: pct(x.rh),
      tempC: celsius(x.t),
      nextTempC: celsius(x.t2),
      outC: celsius(x.out),
      outRhPct: pct(x.outRh),
      dt: minutes(x.dt),
      gainsGph: x.gains,
      removalGph: x.removal,
    });

  it('property: always stays in [0, 100]', () => {
    fc.assert(
      fc.property(inputs, (x) => {
        const next = step(x);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThanOrEqual(100);
      }),
      { numRuns: 10_000 },
    );
  });

  it('property: more removal never gives more humidity', () => {
    fc.assert(
      fc.property(inputs, fc.double({ min: 0, max: 5000, noNaN: true }), (x, extra) => {
        expect(step({ ...x, removal: x.removal + extra })).toBeLessThanOrEqual(step(x) + 1e-6);
      }),
      { numRuns: 10_000 },
    );
  });

  it('property: with occupants and the split running, a steady state exists inside (0, 100)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), fc.double({ min: 0, max: 1000, noNaN: true }), fc.double({ min: 40, max: 100, noNaN: true }), (people, removal, outRh) => {
        let rh = pct(50);
        let previous = -1;
        for (let i = 0; i < 400; i++) {
          previous = rh;
          rh = stepRoomMoisture({ ...base, rhPct: rh, outRhPct: pct(outRh), gainsGph: people * 60 + 50, removalGph: removal, dt: minutes(15) });
        }
        expect(Math.abs(rh - previous)).toBeLessThan(1e-3);
        expect(rh).toBeGreaterThan(0);
        expect(rh).toBeLessThanOrEqual(100);
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('feelsLikeC (comfort only, never safety)', () => {
  const fan = { effectC: 1.5, maxAirC: 35 };

  it('is the air temperature below the heat-index range', () => {
    expect(feelsLikeC({ tempC: celsius(24), rhPct: pct(60) })).toBe(24);
  });

  it('follows the NOAA heat index: 90 F at 60 % feels like about 100 F', () => {
    expect(feelsLikeC({ tempC: celsius((90 - 32) / 1.8), rhPct: pct(60) })).toBeCloseTo((99.7 - 32) / 1.8, 1);
  });

  it('a fan lowers the feels-like temperature by the configured effect', () => {
    const still = feelsLikeC({ tempC: celsius(27), rhPct: pct(50) });
    const breeze = feelsLikeC({ tempC: celsius(27), rhPct: pct(50), fan });
    expect(still - breeze).toBeCloseTo(1.5, 9);
  });

  it('from 35 °C of air a fan brings no benefit (UKHSA; Lancet Planet Health 2024): only below the threshold', () => {
    const benefit = (t: number) => feelsLikeC({ tempC: celsius(t), rhPct: pct(30) }) - feelsLikeC({ tempC: celsius(t), rhPct: pct(30), fan });
    expect(benefit(34.9)).toBeCloseTo(1.5, 9);
    expect(benefit(35)).toBe(0);
    expect(benefit(35.1)).toBe(0);
  });

  it('never feels colder than the air without a fan in the heat', () => {
    fc.assert(
      fc.property(fc.double({ min: 27, max: 38, noNaN: true }), fc.double({ min: 0, max: 70, noNaN: true }), (t, rh) => {
        expect(feelsLikeC({ tempC: celsius(t), rhPct: pct(rh) })).toBeGreaterThanOrEqual(t - 1e-9);
      }),
    );
  });

  it('property: a fan never makes it feel colder than the air minus its effect, nor warmer than without it', () => {
    fc.assert(
      fc.property(fc.double({ min: 20, max: 40, noNaN: true }), fc.double({ min: 0, max: 70, noNaN: true }), (t, rh) => {
        const still = feelsLikeC({ tempC: celsius(t), rhPct: pct(rh) });
        const breeze = feelsLikeC({ tempC: celsius(t), rhPct: pct(rh), fan });
        expect(breeze).toBeLessThanOrEqual(still);
        expect(still - breeze).toBeCloseTo(t < fan.maxAirC ? fan.effectC : 0, 9);
      }),
    );
  });
});

describe('pvPowerW = peak x irradiance x (1 - losses)', () => {
  it('gives the peak minus losses at 1000 W/m²', () => {
    expect(pvPowerW({ peakW: watt(7360), irradianceWm2: 1000, lossRatio: 0.14 })).toBeCloseTo(6329.6, 6);
  });

  it('is zero at night and never negative', () => {
    expect(pvPowerW({ peakW: watt(7360), irradianceWm2: 0, lossRatio: 0.14 })).toBe(0);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1400, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (g, loss) => {
        expect(pvPowerW({ peakW: watt(7360), irradianceWm2: g, lossRatio: loss })).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});
