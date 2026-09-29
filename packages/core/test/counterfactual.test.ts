import { HomeProfileSchema, celsius, pct, watt } from '@cold-reserve/contracts';
import { exampleHomeProfile } from '@cold-reserve/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import { lineMetrics, naiveControls, noPlanControls } from '../src/counterfactual.js';
import { heatIndexExcessC } from '../src/night.js';
import type { ProjectionPoint } from '../src/projection.js';

const profile = HomeProfileSchema.parse(exampleHomeProfile());
const TZ = 'Europe/Rome';
const cfg = { windowStartHour: 22, windowEndHour: 7, heatIndexBaseC: 26.7 };
const flows = {
  pvUsedW: watt(0), curtailedW: watt(0), chargeW: watt(0), dischargeW: watt(0), gridImportW: watt(0), gridExportW: watt(0),
  gridW: watt(0), servedLoadW: watt(0), unservedLoadW: watt(0), nextSocPct: pct(50), pvW: watt(0), loadW: watt(0), hvacW: watt(0), fansW: watt(0),
};
const points = (startIso: string, temps: number[], rh = 50): ProjectionPoint[] =>
  temps.map((t, i) => ({ ms: Date.parse(startIso) + i * 3_600_000, socPct: pct(50), rooms: [{ id: 'bedroom-1', tempC: celsius(t), humidityPct: pct(rh) }], flows }));

describe('lineMetrics', () => {
  // 20:00 to 07:00 local, hourly.
  const p = points('2026-07-15T20:00:00+02:00', [27, 28, 29, 30, 31, 30, 29, 28, 27, 26, 25]);
  const m = lineMetrics(p, { roomId: 'bedroom-1', tz: TZ, stepMinutes: 60, thresholdC: 26, config: cfg });

  it('finds the peak and when it happens (the first time, on a plateau)', () => {
    expect(m?.peakTempC).toBe(31);
    expect(m?.peakAtMs).toBe(Date.parse('2026-07-16T00:00:00+02:00'));
  });

  it('sums heat-index degree-hours over the whole projection', () => {
    const expected = [27, 28, 29, 30, 31, 30, 29, 28, 27, 26, 25].reduce((s, t) => s + heatIndexExcessC(celsius(t), pct(50), 26.7), 0);
    expect(m?.heatIndexDegreeHours).toBeCloseTo(expected, 9);
  });

  it('counts the night hours at or below the threshold', () => {
    expect(m?.hoursAtOrBelowThreshold).toBe(2);
  });

  it('gives zero night hours when the projection has no night', () => {
    const day = lineMetrics(points('2026-07-15T10:00:00+02:00', [25, 25]), { roomId: 'bedroom-1', tz: TZ, stepMinutes: 60, thresholdC: 26, config: cfg });
    expect(day?.hoursAtOrBelowThreshold).toBe(0);
  });

  it('is undefined for a room the projection does not have', () => {
    expect(lineMetrics(p, { roomId: 'living', tz: TZ, stepMinutes: 60, thresholdC: 26, config: cfg })).toBeUndefined();
  });
});

describe('counterfactual controls', () => {
  it('no plan: nothing runs anywhere', () => {
    expect(noPlanControls(profile)).toEqual(profile.rooms.map((r) => ({ id: r.id, fanOn: false })));
  });

  it('naive: every occupied room and the safe room cooled at the comfort setpoint, fans on where there are fans', () => {
    const c = naiveControls(profile, { occupied: ['living'], safeRoomId: 'bedroom-1', setpointC: celsius(25) });
    expect(c).toEqual([
      { id: 'bedroom-1', hvac: { mode: 'cool', setpointC: 25 }, fanOn: true },
      { id: 'living', hvac: { mode: 'cool', setpointC: 25 }, fanOn: false },
      { id: 'study', fanOn: false },
    ]);
  });
});
