import { ForecastSchema, HomeProfileSchema, pct, watt } from '@cold-reserve/contracts';
import { exampleForecast, exampleHomeProfile } from '@cold-reserve/contracts/fixtures';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { batteryCapacityWh } from '../src/energy.js';
import { darkWindow, hoursAtLoad, reserveFloorSocPct, reserveOutlookHours, reserveWh, usableWh, withDischargeFloor } from '../src/reserve.js';

// Mutation testing runs the properties with fewer cases (FC_RUNS); CI and local runs use the full count.
const runs = (n: number): number => Number(process.env['FC_RUNS'] ?? n);

const profile = HomeProfileSchema.parse(exampleHomeProfile());
const battery = profile.battery;
const capacity = batteryCapacityWh(battery);
const RUNS = { numRuns: runs(10_000) };

describe('usableWh (plan §3.1)', () => {
  it('is (soc - hardware floor) x capacity x round-trip efficiency', () => {
    expect(usableWh(battery, pct(55))).toBeCloseTo(0.45 * capacity * battery.roundTripEff, 6);
  });

  it('is zero at and below the hardware floor', () => {
    expect(usableWh(battery, pct(battery.minSocHwPct))).toBe(0);
    expect(usableWh(battery, pct(battery.minSocHwPct - 1))).toBe(0);
  });

  it('measures above a higher floor when one is given', () => {
    expect(usableWh(battery, pct(60), pct(50))).toBeCloseTo(0.1 * capacity * battery.roundTripEff, 6);
  });
});

describe('reserveWh and reserveFloorSocPct (plan §3.1)', () => {
  it('covers the essential load for the dark hours, with the losses, up to the cap', () => {
    expect(reserveWh({ essentialLoadW: 350, darkHours: 10, roundTripEff: 0.875, capWh: 6000 })).toBeCloseTo(4000, 6);
    expect(reserveWh({ essentialLoadW: 350, darkHours: 20, roundTripEff: 0.875, capWh: 6000 })).toBe(6000);
    expect(reserveWh({ essentialLoadW: 350, darkHours: 0, roundTripEff: 0.875, capWh: 6000 })).toBe(0);
  });

  it('puts the floor above the hardware minimum by the reserve share of the capacity', () => {
    expect(reserveFloorSocPct(battery, 6000)).toBeCloseTo(battery.minSocHwPct + (6000 / capacity) * 100, 6);
    expect(reserveFloorSocPct(battery, 0)).toBe(battery.minSocHwPct);
  });

  it('never puts the floor above 100 %', () => {
    expect(reserveFloorSocPct(battery, 10 * capacity)).toBe(100);
  });
});

describe('hoursAtLoad: the ice cubes', () => {
  it('is the usable energy above the floor divided by the load', () => {
    expect(hoursAtLoad(battery, pct(60), 500)).toBeCloseTo(usableWh(battery, pct(60)) / 500, 6);
  });

  it('is zero at the floor', () => {
    expect(hoursAtLoad(battery, pct(40), 500, pct(40))).toBe(0);
  });

  it('never decreases when the SOC increases (property, with the floor as a boundary)', () => {
    const soc = fc.oneof(fc.constantFrom(battery.minSocHwPct, battery.minSocHwPct + 1, 100), fc.double({ min: 0, max: 100, noNaN: true }));
    fc.assert(
      fc.property(soc, soc, fc.double({ min: 1, max: 10_000, noNaN: true }), (a, b, load) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(hoursAtLoad(battery, pct(hi), load)).toBeGreaterThanOrEqual(hoursAtLoad(battery, pct(lo), load));
      }),
      RUNS,
    );
  });
});

describe('withDischargeFloor', () => {
  it('keeps the capacity and moves only the floor', () => {
    const b = withDischargeFloor(battery, pct(50));
    expect(b.minSocHwPct).toBe(50);
    expect(batteryCapacityWh(b)).toBeCloseTo(capacity, 6);
  });

  it('never lowers the hardware floor', () => {
    expect(withDischargeFloor(battery, pct(5)).minSocHwPct).toBe(battery.minSocHwPct);
  });
});

describe('darkWindow: from when PV stops covering the essential load to the next sunrise that does', () => {
  const hour = (h: number, irradianceWm2: number) => ({
    ts: new Date(Date.UTC(2026, 6, 15, h)).toISOString(),
    tempOutC: 30,
    humidityOutPct: 50,
    irradianceWm2,
    stormProb: 0,
  });
  const fc0 = exampleForecast();
  const forecast = (irr: number[]) => ForecastSchema.parse({ ...fc0, hourly: irr.map((w, i) => hour(i, w)) });
  const opts = { pvPeakW: watt(7360), lossRatio: 0.14, essentialLoadW: 350 };

  it('starts at the first dark hour and ends at the first bright hour after it', () => {
    const w = darkWindow({ ...opts, forecast: forecast([800, 300, 20, 0, 0, 10, 200, 600]), fromMs: Date.UTC(2026, 6, 15, 0) });
    expect(w).toEqual({ fromMs: Date.UTC(2026, 6, 15, 2), toMs: Date.UTC(2026, 6, 15, 6) });
  });

  it('starts now when it is already dark', () => {
    const w = darkWindow({ ...opts, forecast: forecast([0, 0, 600]), fromMs: Date.UTC(2026, 6, 15, 0, 30) });
    expect(w).toEqual({ fromMs: Date.UTC(2026, 6, 15, 0, 30), toMs: Date.UTC(2026, 6, 15, 2) });
  });

  it('does not depend on the order of the forecast hours', () => {
    const f = forecast([800, 300, 20, 0, 0, 10, 200, 600]);
    const w = darkWindow({ ...opts, forecast: { ...f, hourly: [...f.hourly].reverse() }, fromMs: Date.UTC(2026, 6, 15, 0) });
    expect(w).toEqual({ fromMs: Date.UTC(2026, 6, 15, 2), toMs: Date.UTC(2026, 6, 15, 6) });
  });

  it('ignores an hour that ended exactly when the window is asked (boundary)', () => {
    const w = darkWindow({ ...opts, forecast: forecast([0, 800, 0, 800]), fromMs: Date.UTC(2026, 6, 15, 1) });
    expect(w).toEqual({ fromMs: Date.UTC(2026, 6, 15, 2), toMs: Date.UTC(2026, 6, 15, 3) });
  });

  it('is undefined when the forecast is all bright', () => {
    expect(darkWindow({ ...opts, forecast: forecast([800, 800]), fromMs: Date.UTC(2026, 6, 15, 0) })).toBeUndefined();
  });

  it('is undefined when the forecast never shows the recharge', () => {
    expect(darkWindow({ ...opts, forecast: forecast([800, 0, 0]), fromMs: Date.UTC(2026, 6, 15, 0) })).toBeUndefined();
  });

  it('treats the essential load itself as the boundary', () => {
    // 350 W / (7360 x 0.86) = 55.3 W/m²: at exactly that irradiance the PV covers the load.
    const edge = 350 / (7360 * 0.86) * 1000;
    const w = darkWindow({ ...opts, forecast: forecast([0, edge, edge - 0.01, edge]), fromMs: Date.UTC(2026, 6, 15, 0) });
    expect(w).toEqual({ fromMs: Date.UTC(2026, 6, 15, 0), toMs: Date.UTC(2026, 6, 15, 1) });
  });
});

describe('reserveOutlookHours (the ice cubes, agreed with F8b in #21)', () => {
  const base = { battery, socPct: pct(60), reserveFloorSocPct: pct(40), reserveWh: 4000, currentLoadW: 1000, essentialLoadW: 350 };

  it('on grid counts only the energy above the reserve floor, the same energy for both levels', () => {
    const o = reserveOutlookHours({ ...base, gridAvailable: true });
    const spendable = usableWh(battery, pct(60), pct(40));
    expect(o.hoursAtCurrentLevel).toBeCloseTo(spendable / 1000, 9);
    expect(o.hoursAtEssential).toBeCloseTo(spendable / 350, 9);
  });

  it('off grid counts down to the hardware floor', () => {
    const o = reserveOutlookHours({ ...base, gridAvailable: false });
    expect(o.hoursAtCurrentLevel).toBeCloseTo(usableWh(battery, pct(60)) / 1000, 9);
  });

  it('the reserve alone at Essential: its energy after the losses, over the essential load', () => {
    expect(reserveOutlookHours({ ...base, gridAvailable: true }).reserveHoursAtEssential).toBeCloseTo((4000 * battery.roundTripEff) / 350, 9);
  });

  it('on grid just above the floor the reserve can outlast the spendable energy (no false invariant)', () => {
    const o = reserveOutlookHours({ ...base, socPct: pct(41), gridAvailable: true });
    expect(o.reserveHoursAtEssential).toBeGreaterThan(o.hoursAtEssential);
  });

  it('property: more charge never gives fewer hours; Essential never lasts less than the current level', () => {
    const soc = fc.oneof(fc.constantFrom(10, 40, 41, 100), fc.double({ min: 0, max: 100, noNaN: true }));
    fc.assert(
      fc.property(soc, soc, fc.boolean(), fc.double({ min: 350, max: 5000, noNaN: true }), (a, b, grid, load) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const at = (s: number) => reserveOutlookHours({ ...base, socPct: pct(s), gridAvailable: grid, currentLoadW: load });
        expect(at(hi).hoursAtCurrentLevel).toBeGreaterThanOrEqual(at(lo).hoursAtCurrentLevel);
        expect(at(hi).hoursAtEssential).toBeGreaterThanOrEqual(at(hi).hoursAtCurrentLevel);
      }),
      { numRuns: runs(10_000) },
    );
  });
});
