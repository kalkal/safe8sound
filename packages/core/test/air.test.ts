import { celsius, minutes, pct, watt } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { feelsLikeC } from '../src/comfort.js';
import { indoorEquilibriumRh, saturationVaporPressureHpa, stepRoomHumidity } from '../src/humidity.js';
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

  it('relaxes toward the equilibrium and removal lowers it', () => {
    const base = { rhPct: pct(70), equilibriumPct: pct(50), dt: minutes(60), exchangeTimeConstantH: 3 };
    const passive = stepRoomHumidity({ ...base, removalPctPerH: 0 });
    expect(passive).toBeLessThan(70);
    expect(passive).toBeGreaterThan(50);
    expect(stepRoomHumidity({ ...base, removalPctPerH: 5 })).toBeLessThan(passive);
  });

  it('always stays in [0, 100]', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0.1, max: 600, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        (rh, eq, dt, removal) => {
          const next = stepRoomHumidity({ rhPct: pct(rh), equilibriumPct: pct(eq), dt: minutes(dt), exchangeTimeConstantH: 3, removalPctPerH: removal });
          expect(next).toBeGreaterThanOrEqual(0);
          expect(next).toBeLessThanOrEqual(100);
        },
      ),
    );
  });
});

describe('feelsLikeC (comfort only, never safety)', () => {
  it('is the air temperature below the heat-index range', () => {
    expect(feelsLikeC({ tempC: celsius(24), rhPct: pct(60), fanOn: false, fanEffectC: 1.5 })).toBe(24);
  });

  it('follows the NOAA heat index: 90 F at 60 % feels like about 100 F', () => {
    expect(feelsLikeC({ tempC: celsius((90 - 32) / 1.8), rhPct: pct(60), fanOn: false, fanEffectC: 1.5 })).toBeCloseTo((99.7 - 32) / 1.8, 1);
  });

  it('a fan lowers the feels-like temperature by the configured effect', () => {
    const still = feelsLikeC({ tempC: celsius(27), rhPct: pct(50), fanOn: false, fanEffectC: 1.5 });
    const breeze = feelsLikeC({ tempC: celsius(27), rhPct: pct(50), fanOn: true, fanEffectC: 1.5 });
    expect(still - breeze).toBeCloseTo(1.5, 9);
  });

  it('never feels colder than the air without a fan in the heat', () => {
    fc.assert(
      fc.property(fc.double({ min: 27, max: 38, noNaN: true }), fc.double({ min: 0, max: 70, noNaN: true }), (t, rh) => {
        expect(feelsLikeC({ tempC: celsius(t), rhPct: pct(rh), fanOn: false, fanEffectC: 1.5 })).toBeGreaterThanOrEqual(t - 1e-9);
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
