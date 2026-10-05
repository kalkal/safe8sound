import { describe, expect, it } from 'vitest';
import { ArchiveSchema, archiveUrl, clearestDay, hottestDay, hoursOf, monthHours, placeDay, sunOf, wettestNoonWindow, type Archive } from '../scripts/place-from-archive.js';

// L2: building a place file from Open-Meteo's archive, with a made-up answer in its format (never real data, never the
// network). July 2024 plus 2 days, so windows that end on 1-2 August are covered.

const pad = (n: number) => String(n).padStart(2, '0');

function archive(over: { tempOf?: (day: number, hour: number) => number; rainOf?: (day: number, hour: number) => number; sunOf?: (day: number, hour: number) => number } = {}): Archive {
  const time: string[] = [];
  const temperature: (number | null)[] = [];
  const humidity: (number | null)[] = [];
  const radiation: (number | null)[] = [];
  const precipitation: (number | null)[] = [];
  const days: string[] = [];
  for (let d = 1; d <= 33; d++) {
    const date = d <= 31 ? `2024-07-${pad(d)}` : `2024-08-${pad(d - 31)}`;
    days.push(date);
    for (let h = 0; h < 24; h++) {
      time.push(`${date}T${pad(h)}:00`);
      temperature.push(over.tempOf?.(d, h) ?? 20 + h / 4);
      humidity.push(60);
      radiation.push(over.sunOf?.(d, h) ?? (h >= 6 && h <= 20 ? 500 : 0));
      precipitation.push(over.rainOf?.(d, h) ?? 0);
    }
  }
  return ArchiveSchema.parse({
    timezone: 'America/Chicago',
    hourly: { time, temperature_2m: temperature, relative_humidity_2m: humidity, shortwave_radiation: radiation, precipitation },
    daily: { time: days, sunrise: days.map((d) => `${d}T06:30`), sunset: days.map((d) => `${d}T20:15`) },
  });
}

describe('the selection rules (written before any data was fetched)', () => {
  it('heatwave: the day with the highest maximum temperature; on a tie, the earliest', () => {
    const a = archive({ tempOf: (d, h) => (d === 12 && h === 15 ? 39 : d === 25 && h === 16 ? 39 : 30) });
    expect(hottestDay(hoursOf(a), '2024-07')).toMatchObject({ date: '2024-07-12' });
  });

  it('clear-day: the sunniest day among those without any precipitation', () => {
    const a = archive({
      sunOf: (d, h) => (h < 6 || h > 20 ? 0 : d === 9 ? 900 : d === 20 ? 800 : 500),
      rainOf: (d, h) => (d === 9 && h === 3 ? 0.2 : 0),
    });
    // Day 9 is sunnier but it rained there before dawn: day 20 wins.
    expect(clearestDay(hoursOf(a), '2024-07')).toMatchObject({ date: '2024-07-20' });
  });

  it('storm by data: the 24 hours from noon with the most precipitation, across midnight', () => {
    const a = archive({ rainOf: (d, h) => (d === 14 && h >= 18 ? 4 : d === 15 && h < 6 ? 4 : d === 3 && h === 13 ? 10 : 0) });
    expect(wettestNoonWindow(hoursOf(a), '2024-07')).toMatchObject({ date: '2024-07-14' });
  });

  it('every rule says itself in words, stored with the day it chose', () => {
    const hours = hoursOf(archive());
    for (const s of [hottestDay(hours, '2024-07'), clearestDay(hours, '2024-07'), wettestNoonWindow(hours, '2024-07')]) expect(s.rule).toMatch(/2024-07.*earliest/);
  });
});

describe('a scenario day in the place file', () => {
  it("takes the script's hours from its start, across midnight, with the sun inside the window and the next dawn", () => {
    const a = archive();
    const day = placeDay(a, 'America/Chicago', { date: '2024-07-07', rule: 'Hurricane Beryl, by name.' }, { startHour: 12, durationH: 24 });
    expect(day.hourly).toHaveLength(24);
    expect(day.hourly[0]).toEqual({ tempOutC: 23, humidityOutPct: 60, irradianceWm2: 500 });
    expect(day.hourly[12]).toEqual({ tempOutC: 20, humidityOutPct: 60, irradianceWm2: 0 });
    // 12:00 7 July → 12:00 8 July (CDT, -05:00): the sunset of the 7th, the sunrise of the 8th, and no other.
    expect(day.sun).toEqual({ sunrise: ['2024-07-08T06:30:00-05:00'], sunset: ['2024-07-07T20:15:00-05:00'] });
    expect(day.selectionRule).toBe('Hurricane Beryl, by name.');
  });

  it('adds the first sunrise after a window that ends at midnight (the night ends at dawn)', () => {
    const a = archive();
    const startMs = Date.parse('2024-07-10T05:00:00Z');
    expect(sunOf(a, 'America/Chicago', startMs, startMs + 24 * 3_600_000).sunrise).toEqual(['2024-07-10T06:30:00-05:00', '2024-07-11T06:30:00-05:00']);
  });

  it('refuses an archive with a gap: never invented weather', () => {
    const a = archive();
    a.hourly.temperature_2m[100] = null;
    expect(() => hoursOf(a)).toThrow(/gap at 2024-07-05T04:00/);
  });

  it('refuses a window the archive does not cover', () => {
    expect(() => placeDay(archive(), 'America/Chicago', { date: '2024-08-02', rule: 'x' }, { startHour: 12, durationH: 24 })).toThrow(/does not cover/);
  });
});

describe('the nights of the month (D1)', () => {
  it('keeps every hour of the month in local time, and nothing of the next', () => {
    const rows = monthHours(archive(), '2024-07');
    expect(rows).toHaveLength(31 * 24);
    expect(rows[0]).toEqual({ time: '2024-07-01T00:00', tempOutC: 20, humidityOutPct: 60, irradianceWm2: 0 });
    expect(rows.at(-1)?.time).toBe('2024-07-31T23:00');
  });
});

describe('the archive request', () => {
  it('asks ERA5 for the four hourly values and the sun, in the place zone, from the first day to two days after the month', () => {
    const url = new URL(archiveUrl({ latRounded: 29.8, lonRounded: -95.4, tz: 'America/Chicago' }, '2024-07'));
    expect(url.origin + url.pathname).toBe('https://archive-api.open-meteo.com/v1/archive');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: '29.8',
      longitude: '-95.4',
      timezone: 'America/Chicago',
      start_date: '2024-07-01',
      end_date: '2024-08-02',
      models: 'era5',
      hourly: 'temperature_2m,relative_humidity_2m,shortwave_radiation,precipitation',
      daily: 'sunrise,sunset',
    });
  });
});
