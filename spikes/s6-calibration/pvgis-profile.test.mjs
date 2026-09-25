import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPvgisUrl,
  parsePvgisTime,
  localMonthHour,
  typicalDayProfile,
  validateConfig,
  resolveLocation,
  publishedSource,
} from './pvgis-profile.mjs';

const config = {
  location: { latRounded: 41.9, lonRounded: 12.5, timeZone: 'Europe/Rome', isPlaceholder: true },
  pv: { peakKw: 7.36, lossPct: 14, tiltDeg: 30, azimuthDeg: 0 },
  years: { start: 2019, end: 2023 },
  api: { baseUrl: 'https://re.jrc.ec.europa.eu/api/v5_3', timeoutMs: 60000 },
};

test('buildPvgisUrl carries the rounded location and the PV parameters', () => {
  const url = new URL(buildPvgisUrl(config));
  assert.equal(url.pathname, '/api/v5_3/seriescalc');
  assert.equal(url.searchParams.get('lat'), '41.9');
  assert.equal(url.searchParams.get('lon'), '12.5');
  assert.equal(url.searchParams.get('peakpower'), '7.36');
  assert.equal(url.searchParams.get('loss'), '14');
  assert.equal(url.searchParams.get('angle'), '30');
  assert.equal(url.searchParams.get('aspect'), '0');
  assert.equal(url.searchParams.get('pvcalculation'), '1');
  assert.equal(url.searchParams.get('startyear'), '2019');
  assert.equal(url.searchParams.get('endyear'), '2023');
  assert.equal(url.searchParams.get('outputformat'), 'json');
});

test('validateConfig rejects coordinates with more than 1 decimal', () => {
  const precise = { ...config, location: { ...config.location, latRounded: 41.912 } };
  const result = validateConfig(precise);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'LOCATION_NOT_ROUNDED');
});

test('validateConfig accepts a rounded location', () => {
  assert.deepEqual(validateConfig(config), { ok: true, value: config });
});

test('validateConfig rejects a non-positive peak power', () => {
  const bad = { ...config, pv: { ...config.pv, peakKw: 0 } };
  const result = validateConfig(bad);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_PV');
});

test('parsePvgisTime reads the UTC time stamp', () => {
  assert.equal(parsePvgisTime('20200101:0010').toISOString(), '2020-01-01T00:10:00.000Z');
  assert.equal(parsePvgisTime('20200715:1310').toISOString(), '2020-07-15T13:10:00.000Z');
});

test('parsePvgisTime rejects a malformed stamp', () => {
  assert.throws(() => parsePvgisTime('2020-01-01 00:10'), /Unexpected PVGIS time/);
});

test('localMonthHour converts UTC to local time with daylight saving', () => {
  // July: CEST = UTC+2
  assert.deepEqual(localMonthHour(new Date('2020-07-15T10:10:00Z'), 'Europe/Rome'), { month: 7, hour: 12 });
  // January: CET = UTC+1
  assert.deepEqual(localMonthHour(new Date('2020-01-15T23:10:00Z'), 'Europe/Rome'), { month: 1, hour: 0 });
});

test('typicalDayProfile averages power by month and local hour', () => {
  const hourly = [
    { time: '20200715:1010', P: 4000 },
    { time: '20210715:1010', P: 6000 },
    { time: '20200715:0010', P: 0 },
    { time: '20200115:1110', P: 2000 },
  ];
  const profile = typicalDayProfile(hourly, { timeZone: 'Europe/Rome', peakKw: 7.36 });
  const july = profile.months.find((m) => m.month === 7);
  assert.equal(july.meanW[12], 5000);
  assert.equal(july.meanW[2], 0);
  assert.equal(july.p90W[12], 6000);
  const january = profile.months.find((m) => m.month === 1);
  assert.equal(january.meanW[12], 2000);
  assert.equal(profile.months.length, 12);
  // months without samples are null, never a silent zero
  const march = profile.months.find((m) => m.month === 3);
  assert.equal(march.meanW[12], null);
});

test('typicalDayProfile reports daily energy per month in kWh', () => {
  const hourly = [];
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, '0');
    hourly.push({ time: `20200715:${hh}10`, P: 1000 });
  }
  const profile = typicalDayProfile(hourly, { timeZone: 'Europe/Rome', peakKw: 7.36 });
  const july = profile.months.find((m) => m.month === 7);
  assert.equal(july.dailyKwh, 24);
  assert.equal(july.specificDailyKwhPerKwp, Number((24 / 7.36).toFixed(3)));
});

test('resolveLocation keeps the committed placeholder when no env values are set', () => {
  const result = resolveLocation(config, {});
  assert.equal(result.ok, true);
  assert.equal(result.value.location.latRounded, 41.9);
  assert.equal(result.value.locationSource, 'config');
});

test('resolveLocation takes PVGIS_LAT and PVGIS_LON from the environment', () => {
  const result = resolveLocation(config, { PVGIS_LAT: '10.1', PVGIS_LON: '20.2' });
  assert.equal(result.ok, true);
  assert.equal(result.value.location.latRounded, 10.1);
  assert.equal(result.value.location.lonRounded, 20.2);
  assert.equal(result.value.location.timeZone, 'Europe/Rome');
  assert.equal(result.value.locationSource, 'env');
});

test('resolveLocation rejects only one of the two env values', () => {
  const result = resolveLocation(config, { PVGIS_LAT: '10.1' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'LOCATION_ENV_INCOMPLETE');
});

test('resolveLocation rejects env values that are not numbers', () => {
  const result = resolveLocation(config, { PVGIS_LAT: 'abc', PVGIS_LON: '20.2' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'LOCATION_NOT_ROUNDED');
});

test('resolveLocation rejects env values with more than 1 decimal', () => {
  const result = resolveLocation(config, { PVGIS_LAT: '10.12', PVGIS_LON: '20.2' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'LOCATION_NOT_ROUNDED');
});

test('publishedSource never contains coordinates taken from the environment', () => {
  const resolved = resolveLocation(config, { PVGIS_LAT: '10.1', PVGIS_LON: '20.2' }).value;
  const source = publishedSource(resolved, 'PVGIS-SARAH3');
  const text = JSON.stringify(source);
  assert.equal(text.includes('10.1'), false);
  assert.equal(text.includes('20.2'), false);
  assert.equal(source.location, 'local .env (rounded to 1 decimal, not published)');
});

test('publishedSource shows the placeholder coordinates when they come from the config', () => {
  const resolved = resolveLocation(config, {}).value;
  const source = publishedSource(resolved, 'PVGIS-SARAH3');
  assert.deepEqual(source.location, { lat: 41.9, lon: 12.5, isPlaceholder: true });
});

test('resolveLocation refuses a real location written in the committed config', () => {
  const real = { ...config, location: { ...config.location, isPlaceholder: false } };
  const result = resolveLocation(real, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'LOCATION_IN_CONFIG');
});

test('resolveLocation treats empty env values as unset', () => {
  const result = resolveLocation(config, { PVGIS_LAT: '', PVGIS_LON: ' ' });
  assert.equal(result.ok, true);
  assert.equal(result.value.locationSource, 'config');
});
