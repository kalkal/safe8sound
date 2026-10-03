import type { Celsius, Pct } from '@cold-reserve/contracts';
import { feelsLikeC } from './comfort.js';
import type { ProjectionPoint } from './projection.js';
import { localHour } from './time.js';

// Night recovery metrics of a room over a projection (feature queue item 1). Definitions:
// - night window 22:00-07:00 local time: bedroom night hours of CIBSE TM59
//   (overheating of bedrooms is judged on the hours from 10 pm to 7 am);
// - heat-index degree-hours: sum of max(0, HI - base) x hours, base 26.7 °C (80 °F), where the NOAA heat
//   index is defined and the "caution" band of the EnergyPlus resilience metrics starts
//   (https://bigladdersoftware.com/epx/docs/24-1/engineering-reference/resilience-metrics.html).
// These are comfort-for-sleep metrics; nothing here claims a medical outcome.

/** The hours of the night window, on the home's wall clock. */
export type NightWindowHours = Pick<NightWindowConfig, 'windowStartHour' | 'windowEndHour'>;

export interface NightWindowConfig {
  readonly windowStartHour: number;
  readonly windowEndHour: number;
  readonly heatIndexBaseC: number;
}

export interface NightMetrics {
  /** The part of the first night window the projection covers. */
  readonly window: { readonly startMs: number; readonly endMs: number };
  readonly coveredHours: number;
  /** Hours with the room air at or below the threshold. */
  readonly achievedHours: number;
  readonly heatIndexDegreeHours: number;
}

/** Heat index above the base, in K; zero where the NOAA heat index is not defined (air below 26.7 °C). */
export function heatIndexExcessC(tempC: Celsius, rhPct: Pct, baseC: number): number {
  return Math.max(0, feelsLikeC({ tempC, rhPct }) - baseC);
}

const inWindow = (hour: number, cfg: NightWindowHours) =>
  cfg.windowStartHour > cfg.windowEndHour
    ? hour >= cfg.windowStartHour || hour < cfg.windowEndHour
    : hour >= cfg.windowStartHour && hour < cfg.windowEndHour;

/** Whether an instant falls in the night window, on the home's wall clock. */
export function inNightWindow(ms: number, tz: string, config: NightWindowHours): boolean {
  return inWindow(localHour(ms, tz), config);
}

/** The next night-window stretch in [fromMs, toMs), found on a 5-minute grid; undefined if there is none. */
export function nextNightWindow(fromMs: number, toMs: number, tz: string, config: NightWindowConfig): { startMs: number; endMs: number } | undefined {
  const step = 5 * 60_000;
  // Now, then every 5 minutes on the clock.
  const times = [fromMs];
  for (let ms = (Math.floor(fromMs / step) + 1) * step; ms < toMs; ms += step) times.push(ms);
  let startMs: number | undefined;
  for (const ms of times) {
    const night = inWindow(localHour(ms, tz), config);
    if (startMs === undefined && night) startMs = ms;
    if (startMs !== undefined && !night) return { startMs, endMs: ms };
  }
  return startMs === undefined ? undefined : { startMs, endMs: toMs };
}

/** Metrics over the first contiguous night-window stretch of the projection; undefined if there is none. */
export function nightMetrics(
  points: readonly ProjectionPoint[],
  opts: { roomId: string; tz: string; stepMinutes: number; thresholdC: number; config: NightWindowConfig },
): NightMetrics | undefined {
  const first = points.findIndex((p) => inWindow(localHour(p.ms, opts.tz), opts.config));
  if (first < 0) return undefined;
  const rest = points.slice(first);
  const end = rest.findIndex((p) => !inWindow(localHour(p.ms, opts.tz), opts.config));
  const night = end < 0 ? rest : rest.slice(0, end);
  const stepH = opts.stepMinutes / 60;
  let achieved = 0;
  let degreeHours = 0;
  for (const p of night) {
    const room = p.rooms.find((r) => r.id === opts.roomId);
    if (room === undefined) return undefined;
    if (room.tempC <= opts.thresholdC) achieved += stepH;
    degreeHours += heatIndexExcessC(room.tempC, room.humidityPct, opts.config.heatIndexBaseC) * stepH;
  }
  const startMs = night[0]?.ms ?? 0;
  return {
    window: { startMs, endMs: startMs + night.length * opts.stepMinutes * 60_000 },
    coveredHours: night.length * stepH,
    achievedHours: achieved,
    heatIndexDegreeHours: degreeHours,
  };
}
