import type { Celsius, HomeProfile } from '@cold-reserve/contracts';
import { heatIndexExcessC, nightMetrics, type NightWindowConfig } from './night.js';
import type { ProjectionPoint, RoomControl } from './projection.js';

// Counterfactual lines (feature queue item 2): the same projection with other controls, measured the
// same way as the plan, so "without the plan the bedroom would reach 31 °C at 3 am" is a computed fact.

export interface LineMetrics {
  readonly peakTempC: number;
  readonly peakAtMs: number;
  readonly heatIndexDegreeHours: number;
  readonly hoursAtOrBelowThreshold: number;
}

/** Peak, heat-index degree-hours over the whole projection and night hours at or below the threshold. */
export function lineMetrics(
  points: readonly ProjectionPoint[],
  opts: { roomId: string; tz: string; stepMinutes: number; thresholdC: number; config: NightWindowConfig },
): LineMetrics | undefined {
  const stepH = opts.stepMinutes / 60;
  let peak: { tempC: number; ms: number } | undefined;
  let degreeHours = 0;
  for (const p of points) {
    const room = p.rooms.find((r) => r.id === opts.roomId);
    if (room === undefined) return undefined;
    if (peak === undefined || room.tempC > peak.tempC) peak = { tempC: room.tempC, ms: p.ms };
    degreeHours += heatIndexExcessC(room.tempC, room.humidityPct, opts.config.heatIndexBaseC) * stepH;
  }
  if (peak === undefined) return undefined;
  return {
    peakTempC: peak.tempC,
    peakAtMs: peak.ms,
    heatIndexDegreeHours: degreeHours,
    hoursAtOrBelowThreshold: nightMetrics(points, opts)?.achievedHours ?? 0,
  };
}

/** Without us: nothing runs. */
export function noPlanControls(profile: HomeProfile): RoomControl[] {
  return profile.rooms.map((r) => ({ id: r.id, fanOn: false }));
}

/**
 * The naive plan, "AC until the battery dies": the safe room and every occupied room cooled at the comfort
 * setpoint, fans on where there are fans, no pacing and no reserve.
 */
export function naiveControls(profile: HomeProfile, opts: { occupied: readonly string[]; safeRoomId: string; setpointC: Celsius }): RoomControl[] {
  return profile.rooms.map((r): RoomControl => {
    const cools = r.hvacUnits.some((u) => u.modes.includes('cool'));
    if (!cools || (r.id !== opts.safeRoomId && !opts.occupied.includes(r.id))) return { id: r.id, fanOn: false };
    return { id: r.id, hvac: { mode: 'cool', setpointC: opts.setpointC }, fanOn: r.fans.length > 0 };
  });
}
