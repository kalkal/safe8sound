import { HomeProfileSchema, minutes, pct, watt } from '@cold-reserve/contracts';
import { exampleHomeProfile } from '@cold-reserve/contracts/fixtures';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { acLimitW, batteryCapacityWh, dispatch, type DispatchInput } from '../src/energy.js';

// Spike S6 plant: 13.8 kWh usable above a 10 % floor, 5 kW each way, round trip 0.884.
const profile = HomeProfileSchema.parse(exampleHomeProfile());
const battery = profile.battery;

const input = (over: Partial<DispatchInput> = {}): DispatchInput => ({
  pvW: watt(0),
  loadW: watt(0),
  socPct: pct(50),
  gridAvailable: true,
  dt: minutes(1),
  battery,
  acLimitW: acLimitW(profile, true),
  ...over,
});

const arbitraryInput = fc.record({
  pv: fc.double({ min: 0, max: 9000, noNaN: true }),
  load: fc.double({ min: 0, max: 15_000, noNaN: true }),
  soc: fc.double({ min: 10, max: 100, noNaN: true }),
  grid: fc.boolean(),
  dt: fc.double({ min: 1 / 60, max: 180, noNaN: true }),
});
const toInput = (a: { pv: number; load: number; soc: number; grid: boolean; dt: number }): DispatchInput =>
  input({ pvW: watt(a.pv), loadW: watt(a.load), socPct: pct(a.soc), gridAvailable: a.grid, dt: minutes(a.dt), acLimitW: acLimitW(profile, a.grid) });

describe('battery capacity', () => {
  it('makes the span from the hardware floor to 100 % exactly the usable energy', () => {
    expect(batteryCapacityWh(battery) * 0.9).toBeCloseTo(13_800, 6);
  });
});

describe('acLimitW', () => {
  it('is the inverter AC rating on grid and the EPS rating off grid (spike S6: 5000 VA, power factor 1)', () => {
    expect(acLimitW(profile, true)).toBe(6000);
    expect(acLimitW(profile, false)).toBe(5000);
  });
});

describe('dispatch (self-consumption)', () => {
  it('charges the battery with the PV surplus, then exports', () => {
    const d = dispatch(input({ pvW: watt(7000), loadW: watt(1000) }));
    expect(d.chargeW).toBe(5000);
    expect(d.gridExportW).toBeCloseTo(1000, 9);
    expect(d.gridW).toBeCloseTo(-1000, 9);
    expect(d.nextSocPct).toBeGreaterThan(50);
  });

  it('discharges the battery for the deficit, then imports', () => {
    const d = dispatch(input({ loadW: watt(6500) }));
    expect(d.dischargeW).toBe(5000);
    expect(d.gridImportW).toBeCloseTo(1500, 9);
    expect(d.nextSocPct).toBeLessThan(50);
  });

  it('applies the square root of the round trip efficiency in each direction', () => {
    const cap = batteryCapacityWh(battery);
    const charged = dispatch(input({ pvW: watt(1000), dt: minutes(60) }));
    expect((charged.nextSocPct - 50) / 100 * cap).toBeCloseTo(1000 * Math.sqrt(0.884), 6);
    const drawn = dispatch(input({ loadW: watt(1000), dt: minutes(60) }));
    expect((50 - drawn.nextSocPct) / 100 * cap).toBeCloseTo(1000 / Math.sqrt(0.884), 6);
  });

  it('stops discharging at the hardware floor', () => {
    const d = dispatch(input({ loadW: watt(3000), socPct: pct(10) }));
    expect(d.dischargeW).toBe(0);
    expect(d.gridImportW).toBe(3000);
  });

  it('off grid: no import, no export, unserved load when the battery cannot cover it', () => {
    const d = dispatch(input({ loadW: watt(3000), socPct: pct(10), gridAvailable: false, acLimitW: acLimitW(profile, false) }));
    expect(d.gridW).toBe(0);
    expect(d.servedLoadW).toBe(0);
    expect(d.unservedLoadW).toBe(3000);
  });

  it('off grid: PV surplus beyond the battery is curtailed', () => {
    const d = dispatch(input({ pvW: watt(7000), loadW: watt(500), socPct: pct(100), gridAvailable: false, acLimitW: acLimitW(profile, false) }));
    expect(d.gridExportW).toBe(0);
    expect(d.curtailedW).toBeCloseTo(6500, 9);
  });

  it('off grid: the EPS rating caps what the inverter delivers', () => {
    const d = dispatch(input({ loadW: watt(7000), socPct: pct(90), gridAvailable: false, acLimitW: acLimitW(profile, false) }));
    expect(d.servedLoadW).toBe(5000);
    expect(d.unservedLoadW).toBe(2000);
  });

  it('property: SOC never leaves [minimum, 100]', () => {
    fc.assert(
      fc.property(arbitraryInput, (a) => {
        const d = dispatch(toInput(a));
        expect(d.nextSocPct).toBeGreaterThanOrEqual(battery.minSocHwPct);
        expect(d.nextSocPct).toBeLessThanOrEqual(100);
      }),
    );
  });

  it('property: SOC stays in range over a long random sequence', () => {
    fc.assert(
      fc.property(fc.array(arbitraryInput, { minLength: 1, maxLength: 200 }), (steps) => {
        let soc = pct(50);
        for (const s of steps) {
          soc = dispatch({ ...toInput(s), socPct: soc }).nextSocPct;
          expect(soc).toBeGreaterThanOrEqual(battery.minSocHwPct);
          expect(soc).toBeLessThanOrEqual(100);
        }
      }),
    );
  });

  it('property: the AC energy balance holds each step', () => {
    fc.assert(
      fc.property(arbitraryInput, (a) => {
        const d = dispatch(toInput(a));
        const sources = d.pvUsedW + d.gridImportW + d.dischargeW;
        const sinks = d.servedLoadW + d.chargeW + d.gridExportW;
        expect(sources).toBeCloseTo(sinks, 6);
        expect(d.pvUsedW + d.curtailedW).toBeCloseTo(a.pv, 6);
        expect(d.servedLoadW + d.unservedLoadW).toBeCloseTo(a.load, 6);
        expect(d.gridW).toBeCloseTo(d.gridImportW - d.gridExportW, 9);
      }),
    );
  });

  it('property: the stored energy changes by exactly the battery flows and their losses', () => {
    fc.assert(
      fc.property(arbitraryInput, (a) => {
        const i = toInput(a);
        const d = dispatch(i);
        const eta = Math.sqrt(battery.roundTripEff);
        const expectedWh = (d.chargeW * eta - d.dischargeW / eta) * (a.dt / 60);
        expect(((d.nextSocPct - a.soc) / 100) * batteryCapacityWh(battery)).toBeCloseTo(expectedWh, 4);
      }),
    );
  });

  it('property: every flow respects its limit', () => {
    fc.assert(
      fc.property(arbitraryInput, (a) => {
        const d = dispatch(toInput(a));
        for (const flow of [d.pvUsedW, d.curtailedW, d.chargeW, d.dischargeW, d.gridImportW, d.gridExportW, d.servedLoadW, d.unservedLoadW]) {
          expect(flow).toBeGreaterThanOrEqual(0);
        }
        expect(d.chargeW).toBeLessThanOrEqual(battery.maxChargeW);
        expect(d.dischargeW).toBeLessThanOrEqual(battery.maxDischargeW);
        if (a.grid) {
          expect(d.unservedLoadW).toBe(0);
        } else {
          expect(d.gridImportW + d.gridExportW).toBe(0);
        }
        // Inverter AC output: PV to the house and the grid plus battery discharge.
        const acOut = d.servedLoadW - d.gridImportW + d.gridExportW;
        expect(acOut).toBeLessThanOrEqual(acLimitW(profile, a.grid) + 1e-6);
      }),
    );
  });
});
