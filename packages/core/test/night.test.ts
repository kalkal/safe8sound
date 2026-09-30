import { celsius, pct, watt } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { OFFSET_CACHE_LIMIT, heatIndexExcessC, localHour, nextNightWindow, nightMetrics, offsetCacheSize, type NightWindowConfig } from '../src/night.js';
import type { ProjectionPoint } from '../src/projection.js';

const TZ = 'Europe/Rome';
const MIN = 60_000;
const cfg: NightWindowConfig = { windowStartHour: 22, windowEndHour: 7, heatIndexBaseC: 26.7 };

const zeroFlows = {
  pvUsedW: watt(0), curtailedW: watt(0), chargeW: watt(0), dischargeW: watt(0), gridImportW: watt(0), gridExportW: watt(0),
  gridW: watt(0), servedLoadW: watt(0), unservedLoadW: watt(0), nextSocPct: pct(50), pvW: watt(0), loadW: watt(0), hvacW: watt(0), fansW: watt(0),
};

/** Points every `step` minutes from `startIso`, with the bedroom temperature from `temp(i)`. */
function points(startIso: string, count: number, step: number, temp: (i: number) => number, rh = 50): ProjectionPoint[] {
  const t0 = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => ({
    ms: t0 + i * step * MIN,
    socPct: pct(50),
    rooms: [{ id: 'bedroom-1', tempC: celsius(temp(i)), humidityPct: pct(rh) }],
    flows: zeroFlows,
  }));
}

describe('localHour', () => {
  it('reads the wall-clock hour in the home time zone, summer time included', () => {
    expect(localHour(Date.parse('2026-07-15T20:30:00Z'), TZ)).toBeCloseTo(22.5, 9);
    expect(localHour(Date.parse('2026-01-15T21:30:00Z'), TZ)).toBeCloseTo(22.5, 9);
  });

  it('handles zones west of UTC, half-hour offsets and the change of day', () => {
    expect(localHour(Date.parse('2026-07-16T02:15:00Z'), 'America/New_York')).toBeCloseTo(22.25, 9);
    expect(localHour(Date.parse('2026-07-15T18:45:00Z'), 'Asia/Kolkata')).toBeCloseTo(0.25, 9);
    expect(localHour(Date.parse('2026-03-29T00:59:00Z'), TZ)).toBeCloseTo(1 + 59 / 60, 9);
    expect(localHour(Date.parse('2026-03-29T01:00:00Z'), TZ)).toBeCloseTo(3, 9);
  });
});

describe('the time-zone offset cache', () => {
  it('stays bounded however many hours are asked, and keeps giving the right hour', () => {
    const t0 = Date.parse('2026-01-01T00:30:00Z');
    for (let h = 0; h < OFFSET_CACHE_LIMIT + 500; h++) localHour(t0 + h * 3_600_000, TZ);
    expect(offsetCacheSize()).toBeLessThanOrEqual(OFFSET_CACHE_LIMIT);
    expect(localHour(Date.parse('2026-07-15T20:30:00Z'), TZ)).toBeCloseTo(22.5, 9);
    expect(localHour(t0, TZ)).toBeCloseTo(1.5, 9);
  });
});

describe('heatIndexExcessC (EnergyPlus resilience metrics, base 26.7 °C)', () => {
  it('is zero below 26.7 °C air', () => {
    expect(heatIndexExcessC(celsius(26.6), pct(90), 26.7)).toBe(0);
  });

  it('grows with humidity above it', () => {
    const dry = heatIndexExcessC(celsius(30), pct(30), 26.7);
    const humid = heatIndexExcessC(celsius(30), pct(80), 26.7);
    expect(dry).toBeGreaterThan(0);
    expect(humid).toBeGreaterThan(dry);
  });
});

describe('nightMetrics (CIBSE TM59 night window 22:00-07:00)', () => {
  it('counts the hours at or below the threshold inside the first night window only', () => {
    // 20:00 to 09:00 local in 5-minute steps; 25 °C before 02:00, 27 °C after.
    const p = points('2026-07-15T20:00:00+02:00', 156, 5, (i) => (i < 72 ? 25 : 27));
    const m = nightMetrics(p, { roomId: 'bedroom-1', tz: TZ, stepMinutes: 5, thresholdC: 26, config: cfg });
    expect(m?.window).toEqual({ startMs: Date.parse('2026-07-15T22:00:00+02:00'), endMs: Date.parse('2026-07-16T07:00:00+02:00') });
    expect(m?.coveredHours).toBeCloseTo(9, 9);
    expect(m?.achievedHours).toBeCloseTo(4, 9);
  });

  it('counts a temperature exactly at the threshold as met (boundary)', () => {
    const p = points('2026-07-15T22:00:00+02:00', 12, 5, () => 26);
    expect(nightMetrics(p, { roomId: 'bedroom-1', tz: TZ, stepMinutes: 5, thresholdC: 26, config: cfg })?.achievedHours).toBeCloseTo(1, 9);
  });

  it('in elderly mode a room at exactly 24 °C counts (boundary)', () => {
    const p = points('2026-07-15T22:00:00+02:00', 12, 5, (i) => (i < 6 ? 24 : 24.01));
    expect(nightMetrics(p, { roomId: 'bedroom-1', tz: TZ, stepMinutes: 5, thresholdC: 24, config: cfg })?.achievedHours).toBeCloseTo(0.5, 9);
  });

  it('cuts the window to what the projection covers', () => {
    const p = points('2026-07-16T03:00:00+02:00', 24, 5, () => 25);
    const m = nightMetrics(p, { roomId: 'bedroom-1', tz: TZ, stepMinutes: 5, thresholdC: 26, config: cfg });
    expect(m?.window.startMs).toBe(Date.parse('2026-07-16T03:00:00+02:00'));
    expect(m?.coveredHours).toBeCloseTo(2, 9);
  });

  it('is undefined when the projection has no night hours', () => {
    const p = points('2026-07-15T10:00:00+02:00', 24, 5, () => 25);
    expect(nightMetrics(p, { roomId: 'bedroom-1', tz: TZ, stepMinutes: 5, thresholdC: 26, config: cfg })).toBeUndefined();
  });

  it('adds up heat-index degree-hours above the base', () => {
    const p = points('2026-07-15T22:00:00+02:00', 12, 5, () => 30, 60);
    const m = nightMetrics(p, { roomId: 'bedroom-1', tz: TZ, stepMinutes: 5, thresholdC: 26, config: cfg });
    expect(m?.heatIndexDegreeHours).toBeCloseTo(heatIndexExcessC(celsius(30), pct(60), 26.7), 9);
  });

  it('supports a window inside one day (a nap, 13:00-16:00), boundaries included at the start only', () => {
    const p = points('2026-07-15T12:00:00+02:00', 60, 5, () => 25);
    const m = nightMetrics(p, { roomId: 'bedroom-1', tz: TZ, stepMinutes: 5, thresholdC: 26, config: { ...cfg, windowStartHour: 13, windowEndHour: 16 } });
    expect(m?.window).toEqual({ startMs: Date.parse('2026-07-15T13:00:00+02:00'), endMs: Date.parse('2026-07-15T16:00:00+02:00') });
    expect(m?.coveredHours).toBeCloseTo(3, 9);
  });

  it('starts the night exactly at 22:00, not before (boundary)', () => {
    const p = points('2026-07-15T21:55:00+02:00', 3, 5, () => 25);
    const m = nightMetrics(p, { roomId: 'bedroom-1', tz: TZ, stepMinutes: 5, thresholdC: 26, config: cfg });
    expect(m?.window.startMs).toBe(Date.parse('2026-07-15T22:00:00+02:00'));
    expect(m?.coveredHours).toBeCloseTo(10 / 60, 9);
  });

  it('is undefined for a room the projection does not have', () => {
    const p = points('2026-07-15T22:00:00+02:00', 12, 5, () => 25);
    expect(nightMetrics(p, { roomId: 'living', tz: TZ, stepMinutes: 5, thresholdC: 26, config: cfg })).toBeUndefined();
  });
});

describe('nextNightWindow', () => {
  const from = Date.parse('2026-07-15T14:00:00+02:00');
  it('finds the next 22:00-07:00 stretch, cut to the range', () => {
    expect(nextNightWindow(from, from + 24 * 3_600_000, TZ, cfg)).toEqual({
      startMs: Date.parse('2026-07-15T22:00:00+02:00'),
      endMs: Date.parse('2026-07-16T07:00:00+02:00'),
    });
    expect(nextNightWindow(from, Date.parse('2026-07-16T03:00:00+02:00'), TZ, cfg)?.endMs).toBe(Date.parse('2026-07-16T03:00:00+02:00'));
  });

  it('on the autumn clock-change night (25/10) the window ends at 07:00 winter time, 06:00Z', () => {
    const from = Date.parse('2026-10-24T20:00:00+02:00');
    expect(nextNightWindow(from, from + 14 * 3_600_000, TZ, cfg)).toEqual({
      startMs: Date.parse('2026-10-24T20:00:00Z'),
      endMs: Date.parse('2026-10-25T06:00:00Z'),
    });
  });

  it('starts now when it is already night, and is undefined when the range has no night', () => {
    const late = Date.parse('2026-07-15T23:30:00+02:00');
    expect(nextNightWindow(late, late + 3_600_000, TZ, cfg)?.startMs).toBe(late);
    expect(nextNightWindow(from, from + 3 * 3_600_000, TZ, cfg)).toBeUndefined();
  });
});
