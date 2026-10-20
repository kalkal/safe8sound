import { describe, expect, it } from 'vitest';
import { isTimeZone, localHour, localIso, localMidnightMs, localTimeText, zonedTimeMs } from '../src/time.js';

// T1 (plan of 2026-10-03): one time helper for every package. Wall-clock times in an IANA zone, right on the
// days the clocks change, for Turin and Houston alike. Nothing here reads the machine's own zone.

const H = 3_600_000;
const TURIN = 'Europe/Rome';
const HOUSTON = 'America/Chicago';

describe('zonedTimeMs: the instant of a wall-clock time in a zone', () => {
  it('gives the instant of a local time in Turin and in Houston', () => {
    expect(new Date(zonedTimeMs('2026-07-15', 22, TURIN)).toISOString()).toBe('2026-07-15T20:00:00.000Z');
    expect(new Date(zonedTimeMs('2026-07-15', 22, HOUSTON)).toISOString()).toBe('2026-07-16T03:00:00.000Z');
    expect(new Date(zonedTimeMs('2026-01-15', 7.5, TURIN)).toISOString()).toBe('2026-01-15T06:30:00.000Z');
  });

  it.each([
    ['Turin, clocks back on 2026-10-25', TURIN, '2026-10-24', '2026-10-25', 10],
    ['Houston, clocks back on 2026-11-01', HOUSTON, '2026-10-31', '2026-11-01', 10],
    ['Turin, clocks forward on 2026-03-29', TURIN, '2026-03-28', '2026-03-29', 8],
    ['Houston, clocks forward on 2026-03-08', HOUSTON, '2026-03-07', '2026-03-08', 8],
    ['an ordinary night', TURIN, '2026-07-15', '2026-07-16', 9],
  ])('the night from 22:00 to 07:00 lasts the hours it really lasts: %s', (_case, tz, evening, morning, hours) => {
    expect((zonedTimeMs(morning, 7, tz) - zonedTimeMs(evening, 22, tz)) / H).toBe(hours);
  });

  it('takes the first instant of a wall-clock time that happens twice, and the next valid one for a time that does not exist', () => {
    // 02:30 happens twice in Turin on 2026-10-25 (CEST, then CET): the first is 00:30 UTC.
    expect(new Date(zonedTimeMs('2026-10-25', 2.5, TURIN)).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    // 02:30 does not exist in Turin on 2026-03-29 (02:00 jumps to 03:00): 03:30 CEST, 01:30 UTC.
    expect(new Date(zonedTimeMs('2026-03-29', 2.5, TURIN)).toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });
});

describe('localMidnightMs: the start of the local day an instant falls in', () => {
  it('is local midnight in the zone, not UTC midnight', () => {
    expect(new Date(localMidnightMs(Date.parse('2026-07-15T12:00:00Z'), TURIN)).toISOString()).toBe('2026-07-14T22:00:00.000Z');
    expect(new Date(localMidnightMs(Date.parse('2026-07-15T23:30:00Z'), TURIN)).toISOString()).toBe('2026-07-15T22:00:00.000Z');
    expect(new Date(localMidnightMs(Date.parse('2026-07-15T03:00:00Z'), HOUSTON)).toISOString()).toBe('2026-07-14T05:00:00.000Z');
  });

  it('gives a 25-hour day when the clocks go back, and the same midnight to every instant of that day', () => {
    const midnight = localMidnightMs(Date.parse('2026-10-25T12:00:00Z'), TURIN);
    const next = localMidnightMs(Date.parse('2026-10-26T12:00:00Z'), TURIN);
    expect((next - midnight) / H).toBe(25);
    expect(localMidnightMs(Date.parse('2026-10-25T22:59:00Z'), TURIN)).toBe(midnight);
  });
});

describe('localHour and localIso, moved here from core/night and mcp-server/time', () => {
  it('reads the wall-clock hour across a clock change', () => {
    expect(localHour(Date.parse('2026-03-29T00:59:00Z'), TURIN)).toBeCloseTo(1 + 59 / 60, 9);
    expect(localHour(Date.parse('2026-03-29T01:00:00Z'), TURIN)).toBeCloseTo(3, 9);
    expect(localHour(Date.parse('2026-07-16T03:00:00Z'), HOUSTON)).toBeCloseTo(22, 9);
  });

  it('writes ISO 8601 with the zone offset of that instant', () => {
    expect(localIso(Date.parse('2026-07-15T20:30:00Z'), TURIN)).toBe('2026-07-15T22:30:00+02:00');
    expect(localIso(Date.parse('2026-01-15T20:30:00Z'), TURIN)).toBe('2026-01-15T21:30:00+01:00');
    expect(localIso(Date.parse('2026-07-16T03:00:00Z'), HOUSTON)).toBe('2026-07-15T22:00:00-05:00');
    expect(localTimeText('2026-07-15T22:30:00+02:00')).toBe('22:30');
  });
});

describe('isTimeZone', () => {
  it('accepts IANA zones and refuses anything else', () => {
    expect(isTimeZone(TURIN)).toBe(true);
    expect(isTimeZone(HOUSTON)).toBe(true);
    for (const bad of ['', 'Mars/Olympus', '+02:00', 'Europe/Romee']) expect(isTimeZone(bad)).toBe(false);
  });
});
