// T1 (plan of 2026-10-03): the one place for wall-clock time in an IANA zone. The night window, the guard,
// the scenario clock and the times the model reads all use these, so Turin and Houston and the days the
// clocks change agree everywhere. Nothing here reads the machine's own zone.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Whether `tz` is an IANA time zone this runtime knows (e.g. Europe/Rome, America/Chicago). */
export function isTimeZone(tz: string): boolean {
  if (tz.trim() === '' || !tz.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wall clock minus UTC, modulo a day, per time zone and UTC hour: offsets change only on whole hours
 * (half-hour zones still change on the hour), and Intl is slow. A bounded LRU: a warm Lambda serving many
 * days never grows it past the limit.
 */
export const OFFSET_CACHE_LIMIT = 1024;
const offsets = new Map<string, number>();

/** Entries in the offset cache (for tests). */
export const offsetCacheSize = (): number => offsets.size;

function offsetModDayMs(hourStartMs: number, tz: string): number {
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

/** Wall-clock hour (0-24, fractional) in the zone. */
export function localHour(ms: number, tz: string): number {
  const local = ms + offsetModDayMs(Math.floor(ms / HOUR_MS) * HOUR_MS, tz);
  return (((local % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS;
}

/** The wall-clock fields of an instant in a zone. */
function wallParts(ms: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'longOffset',
  }).formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute'), second: part('second'), offset: part('timeZoneName').replace('GMT', '') || '+00:00' };
}

/** The zone's full offset (wall clock minus UTC) at an instant, in ms. */
function zoneOffsetMs(ms: number, tz: string): number {
  const p = wallParts(ms, tz);
  const wallAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant of a wall-clock time (`hour`, fractional) on a local date (YYYY-MM-DD) in a zone. A time that
 * happens twice (clocks going back) is its first instant; a time that does not exist (clocks going forward)
 * is the instant it would be on the offset before the jump, i.e. the same distance after the jump.
 */
export function zonedTimeMs(date: string, hour: number, tz: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wanted = Date.UTC(y, m - 1, d) + Math.round(hour * HOUR_MS);
  // The offsets around this day: before and after any change on it.
  const before = zoneOffsetMs(wanted - DAY_MS, tz);
  const after = zoneOffsetMs(wanted + DAY_MS, tz);
  const valid = [before, after].map((o) => wanted - o).filter((t) => zoneOffsetMs(t, tz) === wanted - t);
  return valid.length > 0 ? Math.min(...valid) : wanted - before;
}

/** The start (local midnight) of the local day an instant falls in. */
export function localMidnightMs(ms: number, tz: string): number {
  const p = wallParts(ms, tz);
  return zonedTimeMs(`${p.year}-${p.month}-${p.day}`, 0, tz);
}

/** ISO 8601 in the zone, with its offset: the times the model reads match the family message. */
export function localIso(ms: number, tz: string): string {
  const p = wallParts(ms, tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.offset}`;
}

/**
 * "9:30 PM": the clock time as the family message says it, from a time already in the home's zone (localIso).
 * The text the model may read aloud carries the clock time only; the exact time is in the structured result.
 */
export function localTimeText(iso: string): string {
  const hour = Number(iso.slice(11, 13));
  return `${String(hour % 12 || 12)}:${iso.slice(14, 16)} ${hour < 12 ? 'AM' : 'PM'}`;
}
