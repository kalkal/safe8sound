import type { Celsius, Pct } from '@cold-reserve/contracts';
import { feelsLikeC } from './comfort.js';
import type { ProjectionPoint } from './projection.js';

// Night recovery metrics of a room over a projection (feature queue item 1). Definitions:
// - night window 22:00-07:00 local time: bedroom night hours of CIBSE TM59
//   (overheating of bedrooms is judged on the hours from 10 pm to 7 am);
// - heat-index degree-hours: sum of max(0, HI - base) x hours, base 26.7 °C (80 °F), where the NOAA heat
//   index is defined and the "caution" band of the EnergyPlus resilience metrics starts
//   (https://bigladdersoftware.com/epx/docs/24-1/engineering-reference/resilience-metrics.html).
// These are comfort-for-sleep metrics; nothing here claims a medical outcome.

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

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/**
 * Wall clock minus UTC, modulo a day, per time zone and UTC hour: offsets change only on whole hours
 * (half-hour zones still change on the hour), and Intl is slow. A bounded LRU: a warm Lambda serving many
 * days never grows it past the limit.
 */
export const OFFSET_CACHE_LIMIT = 1024;
const offsets = new Map<string, number>();

/** Entries in the offset cache (for tests). */
export const offsetCacheSize = (): number => offsets.size;

function offsetMs(hourStartMs: number, tz: string): number {
  const key = `${tz}|${String(hourStartMs)}`;
  const cached = offsets.get(key);
  if (cached !== undefined) {
    // Most recently used goes last; the oldest is first in the Map's order.
    offsets.delete(key);
    offsets.set(key, cached);
    return cached;
  }
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(hourStartMs);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const offset = (part('hour') * 60 + part('minute')) * 60_000 - (hourStartMs % DAY_MS);
  if (offsets.size >= OFFSET_CACHE_LIMIT) {
    const oldest = offsets.keys().next().value;
    if (oldest !== undefined) offsets.delete(oldest);
  }
  offsets.set(key, offset);
  return offset;
}

/** Wall-clock hour (0-24, fractional) in the home time zone. */
export function localHour(ms: number, tz: string): number {
  const local = ms + offsetMs(Math.floor(ms / HOUR_MS) * HOUR_MS, tz);
  return (((local % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS;
}

/** Heat index above the base, in K; zero where the NOAA heat index is not defined (air below 26.7 °C). */
export function heatIndexExcessC(tempC: Celsius, rhPct: Pct, baseC: number): number {
  return Math.max(0, feelsLikeC({ tempC, rhPct, fanOn: false, fanEffectC: 0 }) - baseC);
}

const inWindow = (hour: number, cfg: NightWindowConfig) =>
  cfg.windowStartHour > cfg.windowEndHour
    ? hour >= cfg.windowStartHour || hour < cfg.windowEndHour
    : hour >= cfg.windowStartHour && hour < cfg.windowEndHour;

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
