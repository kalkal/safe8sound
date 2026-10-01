// Times as the person hears them, in the home's time zone (audit R10, #111): shared by storm mode and the
// comfort plan, so the model says the same clock time the family message and the guard's reasons give.

/** ISO 8601 in the home's time zone, with its offset: the times the model reads match the family message. */
export function localIso(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
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
  const offset = part('timeZoneName').replace('GMT', '') || '+00:00';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset}`;
}

/**
 * "9:30 PM (2026-07-17T21:30:00+02:00)": the clock time as the family message says it, from a time
 * already in the home's zone (localIso), then the exact time.
 */
export function localTimeText(iso: string): string {
  const hour = Number(iso.slice(11, 13));
  return `${String(hour % 12 || 12)}:${iso.slice(14, 16)} ${hour < 12 ? 'AM' : 'PM'} (${iso})`;
}
