import { localIso, zonedTimeMs } from '@cold-reserve/core';
import { z } from 'zod';

// L2: a place file from Open-Meteo's historical archive (ERA5), built once by scripts/fetch-location.ts and committed.
// Pure functions: the selection rules, written before any data was fetched, pick each scenario's real day, and the
// file follows the L1 place schema. Never in CI, tests or the demo: the tests use recorded, made-up responses.

/** The part of an Open-Meteo /v1/archive answer we read: local times in the requested IANA zone. */
export const ArchiveSchema = z.object({
  timezone: z.string(),
  hourly: z.object({
    time: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)),
    temperature_2m: z.array(z.number().nullable()),
    relative_humidity_2m: z.array(z.number().nullable()),
    shortwave_radiation: z.array(z.number().nullable()),
    precipitation: z.array(z.number().nullable()),
  }),
  daily: z.object({
    time: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    sunrise: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)),
    sunset: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)),
  }),
});
export type Archive = z.infer<typeof ArchiveSchema>;

/** One hour as the place file stores it. */
export interface PlaceHour {
  readonly tempOutC: number;
  readonly humidityOutPct: number;
  readonly irradianceWm2: number;
}

interface Hour extends PlaceHour {
  readonly time: string;
  readonly precipitationMm: number;
}

/** The hours of the archive, refusing any gap: a place file never carries invented weather. */
export function hoursOf(archive: Archive): Hour[] {
  const h = archive.hourly;
  return h.time.map((time, i) => {
    const values = [h.temperature_2m[i], h.relative_humidity_2m[i], h.shortwave_radiation[i], h.precipitation[i]];
    if (values.some((v) => v === null || v === undefined)) throw new Error(`The archive has a gap at ${time}.`);
    const [t, rh, sw, p] = values as number[];
    return { time, tempOutC: round1(t ?? 0), humidityOutPct: Math.round(rh ?? 0), irradianceWm2: Math.round(sw ?? 0), precipitationMm: round1(p ?? 0) };
  });
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** The hours of a window: `count` hours from `date` at `startHour`, local time. */
export function windowOf(hours: readonly Hour[], date: string, startHour: number, count: number): Hour[] {
  const first = hours.findIndex((h) => h.time === `${date}T${String(startHour).padStart(2, '0')}:00`);
  if (first === -1 || first + count > hours.length) throw new Error(`The archive does not cover ${String(count)} hours from ${date} ${String(startHour)}:00.`);
  return hours.slice(first, first + count);
}

/** The days of the month the rules choose among (ties: the earliest wins, so the order is the calendar's). */
const daysOfMonth = (month: string): string[] => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
};

const best = <T>(items: readonly T[], score: (t: T) => number): T => {
  let winner: T | undefined;
  let top = -Infinity;
  for (const item of items) {
    const s = score(item);
    if (s > top) {
      top = s;
      winner = item;
    }
  }
  if (winner === undefined) throw new Error('No day matches the selection rule.');
  return winner;
};

export interface Selection {
  readonly date: string;
  readonly rule: string;
}

/** heatwave: the day with the highest maximum 2 m temperature, 00:00–23:00. */
export function hottestDay(hours: readonly Hour[], month: string): Selection {
  const date = best(daysOfMonth(month), (d) => Math.max(...windowOf(hours, d, 0, 24).map((h) => h.tempOutC)));
  return { date, rule: `The day of ${month} with the highest maximum 2 m temperature (00:00-23:00 local); ties: the earliest.` };
}

/** clear-day: among the days without precipitation, the sunniest (highest total shortwave radiation). */
export function clearestDay(hours: readonly Hour[], month: string): Selection {
  const dry = daysOfMonth(month).filter((d) => windowOf(hours, d, 0, 24).every((h) => h.precipitationMm === 0));
  const date = best(dry, (d) => windowOf(hours, d, 0, 24).reduce((sum, h) => sum + h.irradianceWm2, 0));
  return { date, rule: `Among the days of ${month} without precipitation, the one with the most shortwave radiation; ties: the earliest.` };
}

/** storm (by data): the 24 hours from 12:00 with the most precipitation. */
export function wettestNoonWindow(hours: readonly Hour[], month: string): Selection {
  const date = best(daysOfMonth(month), (d) => windowOf(hours, d, 12, 24).reduce((sum, h) => sum + h.precipitationMm, 0));
  return { date, rule: `The 24 hours from 12:00 in ${month} with the most precipitation; ties: the earliest.` };
}

/**
 * Sunrises and sunsets inside the window, as ISO with offset. A window that ends at night (its last event is a
 * sunset) also gets the next sunrise: the night it ends in finishes at dawn.
 */
export function sunOf(archive: Archive, tz: string, startMs: number, endMs: number): { sunrise: string[]; sunset: string[] } {
  const toMs = (local: string) => zonedTimeMs(local.slice(0, 10), Number(local.slice(11, 13)) + Number(local.slice(14, 16)) / 60, tz);
  const inside = (list: readonly string[]) => list.map(toMs).filter((ms) => ms >= startMs && ms < endMs);
  const sunrises = inside(archive.daily.sunrise);
  const sunsets = inside(archive.daily.sunset);
  const endsAtNight = (sunsets.at(-1) ?? -Infinity) > (sunrises.at(-1) ?? -Infinity);
  const next = archive.daily.sunrise.map(toMs).find((ms) => ms >= endMs);
  const iso = (ms: number) => localIso(ms, tz);
  return {
    sunrise: [...sunrises, ...(endsAtNight && next !== undefined ? [next] : [])].map(iso),
    sunset: sunsets.map(iso),
  };
}

export interface ScriptFrame {
  readonly startHour: number;
  readonly durationH: number;
}

/** One scenario's day in the place file: its date, its hours from the script's start, its sun and the rule that chose it. */
export function placeDay(archive: Archive, tz: string, selection: Selection, frame: ScriptFrame) {
  const hours = windowOf(hoursOf(archive), selection.date, frame.startHour, frame.durationH);
  const startMs = zonedTimeMs(selection.date, frame.startHour, tz);
  return {
    date: selection.date,
    selectionRule: selection.rule,
    hourly: hours.map(({ tempOutC, humidityOutPct, irradianceWm2 }) => ({ tempOutC, humidityOutPct, irradianceWm2 })),
    sun: sunOf(archive, tz, startMs, startMs + frame.durationH * 3_600_000),
  };
}

/** Every hour of the month, for the nights study (D1): the place's real July, in local time. */
export function monthHours(archive: Archive, month: string): (PlaceHour & { time: string })[] {
  return hoursOf(archive)
    .filter((h) => h.time.startsWith(month))
    .map(({ time, tempOutC, humidityOutPct, irradianceWm2 }) => ({ time, tempOutC, humidityOutPct, irradianceWm2 }));
}

const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';

/**
 * The one request per place: ERA5 pinned (not Open-Meteo's best-match blend), local times in the place's zone, the
 * whole month plus two days, so a window that starts on the last day (36 hours at most) is covered.
 */
export function archiveUrl(place: { readonly latRounded: number; readonly lonRounded: number; readonly tz: string }, month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const end = new Date(Date.UTC(y, m, 2)).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    latitude: String(place.latRounded),
    longitude: String(place.lonRounded),
    timezone: place.tz,
    start_date: `${month}-01`,
    end_date: end,
    models: 'era5',
    hourly: 'temperature_2m,relative_humidity_2m,shortwave_radiation,precipitation',
    daily: 'sunrise,sunset',
  });
  return `${ARCHIVE}?${params.toString()}`;
}
