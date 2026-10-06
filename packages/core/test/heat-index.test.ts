import { describe, expect, it } from 'vitest';
import { nwsHeatIndexC } from '../src/heat-index.js';

// #248: the NWS heat index, as the guard's heat-danger rule uses it (https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml):
// the simple formula averaged with the temperature; from 80 °F the Rothfusz regression with its two adjustments.

const f = (c: number) => c * 1.8 + 32;
const c = (fahrenheit: number) => (fahrenheit - 32) / 1.8;

describe('nwsHeatIndexC', () => {
  it.each([
    [24, 69, 24.1],
    [24, 60, 24.0],
    [24, 40, 23.75],
    [26, 90, 26.5],
  ])('below 80 °F it is the simple formula averaged with the temperature: %s °C at RH %s → %s °C', (t, rh, hi) => {
    expect(nwsHeatIndexC(t, rh)).toBeCloseTo(hi, 1);
  });

  it.each([
    // The NWS heat index chart (https://www.weather.gov/ama/heatindex, read 2026-10-06), to the chart's whole degrees.
    // The chart starts at 40 % RH, so the dry-air adjustment (under 13 %) is checked against the formula below.
    [86, 60, 91],
    [90, 50, 95],
    [90, 70, 105],
    [100, 40, 109],
    // The humid-air adjustment applies (over 85 %, 80 to 87 °F).
    [84, 95, 100],
    [86, 90, 105],
  ])('from 80 °F it follows the NWS chart: %s °F at RH %s → %s °F', (t, rh, hi) => {
    expect(Math.abs(f(nwsHeatIndexC(c(t), rh)) - hi)).toBeLessThanOrEqual(1);
  });

  it('30 °C at 60 % is in the NWS Extreme Caution band (from 32.2 °C)', () => {
    expect(nwsHeatIndexC(30, 60)).toBeCloseTo(32.8, 0);
    expect(nwsHeatIndexC(30, 60)).toBeGreaterThan(32.2);
  });

  it('subtracts the dry-air adjustment under 13 % between 80 and 112 °F', () => {
    const t = 95;
    const rh = 5;
    const raw =
      -42.379 + 2.04901523 * t + 10.14333127 * rh - 0.22475541 * t * rh - 0.00683783 * t * t - 0.05481717 * rh * rh + 0.00122874 * t * t * rh + 0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh;
    expect(f(nwsHeatIndexC(c(t), rh))).toBeCloseTo(raw - ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(t - 95)) / 17), 6);
  });

  it('adds the humid-air adjustment over 85 % between 80 and 87 °F', () => {
    const t = 82;
    const rh = 95;
    const raw =
      -42.379 + 2.04901523 * t + 10.14333127 * rh - 0.22475541 * t * rh - 0.00683783 * t * t - 0.05481717 * rh * rh + 0.00122874 * t * t * rh + 0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh;
    expect(f(nwsHeatIndexC(c(t), rh))).toBeCloseTo(raw + ((rh - 85) / 10) * ((87 - t) / 5), 6);
  });

  it('switches to the regression where the averaged simple formula reaches 80 °F, not where the air does', () => {
    // 26.5 °C at 95 %: the air is under 80 °F, the averaged simple formula is over it.
    const t = f(26.5);
    const simple = (0.5 * (t + 61 + (t - 68) * 1.2 + 95 * 0.094) + t) / 2;
    expect(t).toBeLessThan(80);
    expect(simple).toBeGreaterThanOrEqual(80);
    expect(f(nwsHeatIndexC(26.5, 95))).not.toBeCloseTo(simple, 3);
  });

  it('rises with humidity at a fixed temperature', () => {
    for (const t of [24, 26, 28, 30, 32]) expect(nwsHeatIndexC(t, 80)).toBeGreaterThan(nwsHeatIndexC(t, 40));
  });
});
