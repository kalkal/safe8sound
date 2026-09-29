import { celsius, minutes, watt } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { coolingToReachW, stepRoomTemperature } from '../src/thermal.js';

// A 15 m² room from spike S6: R = 44.4 K/kW, C = 0.45 kWh/K, tau = 20 h.
const room = { rKPerKw: 44.4, cKwhPerK: 0.45 };
const temp = fc.double({ min: -10, max: 45, noNaN: true });
// Bounded so that Tout + R Q stays a plausible air temperature.
const heat = fc.double({ min: -300, max: 300, noNaN: true });
const dtMin = fc.double({ min: 0.1, max: 120, noNaN: true });

describe('stepRoomTemperature (1R1C, exact solution)', () => {
  it('stays put at equilibrium', () => {
    const t = stepRoomTemperature({ tempC: celsius(26), outC: celsius(26), netHeatW: watt(0), dt: minutes(60), thermal: room });
    expect(t).toBeCloseTo(26, 10);
  });

  it('decays toward the outdoor temperature with tau = R C', () => {
    // After one time constant the gap shrinks to 1/e.
    const t = stepRoomTemperature({ tempC: celsius(36), outC: celsius(26), netHeatW: watt(0), dt: minutes(20 * 60), thermal: { rKPerKw: 40, cKwhPerK: 0.5 } });
    expect(t - 26).toBeCloseTo(10 / Math.E, 6);
  });

  it('settles at Tout + R Q for a constant heat input', () => {
    const t = stepRoomTemperature({ tempC: celsius(20), outC: celsius(30), netHeatW: watt(500), dt: minutes(60 * 24 * 30), thermal: room });
    expect(t).toBeCloseTo(30 + 44.4 * 0.5, 3);
  });

  it('never overshoots its equilibrium, whatever the step length', () => {
    fc.assert(
      fc.property(temp, temp, heat, dtMin, (t0, out, q, dt) => {
        const equilibrium = out + (room.rKPerKw * q) / 1000;
        const t1 = stepRoomTemperature({ tempC: celsius(t0), outC: celsius(out), netHeatW: watt(q), dt: minutes(dt), thermal: room });
        expect(t1).toBeGreaterThanOrEqual(Math.min(t0, equilibrium) - 1e-9);
        expect(t1).toBeLessThanOrEqual(Math.max(t0, equilibrium) + 1e-9);
      }),
    );
  });

  it('two half steps equal one full step (exact integration)', () => {
    fc.assert(
      fc.property(temp, temp, heat, dtMin, (t0, out, q, dt) => {
        const base = { outC: celsius(out), netHeatW: watt(q), thermal: room };
        const full = stepRoomTemperature({ ...base, tempC: celsius(t0), dt: minutes(dt) });
        const half = stepRoomTemperature({ ...base, tempC: celsius(t0), dt: minutes(dt / 2) });
        const twice = stepRoomTemperature({ ...base, tempC: half, dt: minutes(dt / 2) });
        expect(twice).toBeCloseTo(full, 9);
      }),
    );
  });
});

describe('coolingToReachW', () => {
  it('is the cooling that lands the room exactly on the target', () => {
    fc.assert(
      fc.property(temp, temp, fc.double({ min: 15, max: 35, noNaN: true }), heat, fc.double({ min: 1, max: 120, noNaN: true }), (t0, out, target, gains, dt) => {
        const input = { tempC: celsius(t0), outC: celsius(out), gainsW: watt(gains), dt: minutes(dt), thermal: room };
        const cooling = coolingToReachW({ ...input, targetC: celsius(target) });
        const t1 = stepRoomTemperature({ tempC: input.tempC, outC: input.outC, netHeatW: watt(gains - cooling), dt: input.dt, thermal: room });
        expect(t1).toBeCloseTo(target, 4);
      }),
    );
  });

  it('is negative when the room needs heat', () => {
    const w = coolingToReachW({ tempC: celsius(15), outC: celsius(5), targetC: celsius(20), gainsW: watt(0), dt: minutes(1), thermal: room });
    expect(w).toBeLessThan(0);
  });
});
