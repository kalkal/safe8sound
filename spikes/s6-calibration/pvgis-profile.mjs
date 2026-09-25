// Spike S6 (throwaway): builds a typical-day PV profile per month from the PVGIS hourly series.
// Usage: node pvgis-profile.mjs [config.json] [out.json]
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ok = (value) => ({ ok: true, value });
const err = (code, detail) => ({ ok: false, error: { code, detail } });

const hasAtMostOneDecimal = (n) => Number.isFinite(n) && Math.round(n * 10) / 10 === n;

export function validateConfig(config) {
  const loc = config?.location;
  if (!loc || !hasAtMostOneDecimal(loc.latRounded) || !hasAtMostOneDecimal(loc.lonRounded)) {
    return err('LOCATION_NOT_ROUNDED', 'latRounded and lonRounded must have at most 1 decimal');
  }
  const pv = config.pv;
  if (!pv || !(pv.peakKw > 0) || !(pv.lossPct >= 0 && pv.lossPct < 100)) {
    return err('INVALID_PV', 'peakKw must be > 0 and lossPct in [0, 100)');
  }
  return ok(config);
}

// The real rounded location lives only in the untracked .env (PVGIS_LAT / PVGIS_LON);
// the committed config keeps a placeholder.
export function resolveLocation(config, env) {
  const read = (value) => (value === undefined || value.trim() === '' ? undefined : value.trim());
  const lat = read(env.PVGIS_LAT);
  const lon = read(env.PVGIS_LON);
  if (lat === undefined && lon === undefined) {
    if (config.location?.isPlaceholder !== true) {
      return err('LOCATION_IN_CONFIG', 'the committed config may hold only a placeholder; put the real location in .env');
    }
    return ok({ ...config, locationSource: 'config' });
  }
  if (lat === undefined || lon === undefined) {
    return err('LOCATION_ENV_INCOMPLETE', 'set both PVGIS_LAT and PVGIS_LON, or neither');
  }
  const location = { ...config.location, latRounded: Number(lat), lonRounded: Number(lon), isPlaceholder: false };
  const checked = validateConfig({ ...config, location });
  if (!checked.ok) return checked;
  return ok({ ...checked.value, locationSource: 'env' });
}

export function publishedSource(resolved, radiationDb) {
  const location =
    resolved.locationSource === 'env'
      ? 'local .env (rounded to 1 decimal, not published)'
      : {
          lat: resolved.location.latRounded,
          lon: resolved.location.lonRounded,
          isPlaceholder: resolved.location.isPlaceholder === true,
        };
  return {
    tool: 'PVGIS seriescalc',
    apiBaseUrl: resolved.api.baseUrl,
    radiationDb,
    years: resolved.years,
    location,
    pv: resolved.pv,
  };
}

export function buildPvgisUrl(config) {
  const { location, pv, years, api } = config;
  const params = new URLSearchParams({
    lat: String(location.latRounded),
    lon: String(location.lonRounded),
    peakpower: String(pv.peakKw),
    loss: String(pv.lossPct),
    angle: String(pv.tiltDeg),
    aspect: String(pv.azimuthDeg),
    pvcalculation: '1',
    startyear: String(years.start),
    endyear: String(years.end),
    outputformat: 'json',
  });
  return `${api.baseUrl}/seriescalc?${params}`;
}

export function parsePvgisTime(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2}):(\d{2})(\d{2})$/.exec(stamp);
  if (!m) throw new Error(`Unexpected PVGIS time stamp: ${stamp}`);
  const [, y, mo, d, h, mi] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi));
}

const formatters = new Map();
export function localMonthHour(date, timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-GB', { timeZone, month: 'numeric', hour: 'numeric', hourCycle: 'h23' }),
    );
  }
  const parts = formatters.get(timeZone).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { month: get('month'), hour: get('hour') };
}

const round1 = (n) => Math.round(n * 10) / 10;

function percentile(sorted, p) {
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

export function typicalDayProfile(hourly, { timeZone, peakKw }) {
  // buckets[month][hour] = list of AC power samples (W)
  const buckets = Array.from({ length: 13 }, () => Array.from({ length: 24 }, () => []));
  for (const row of hourly) {
    const { month, hour } = localMonthHour(parsePvgisTime(row.time), timeZone);
    buckets[month][hour].push(row.P);
  }
  const months = [];
  for (let month = 1; month <= 12; month++) {
    const meanW = [];
    const p90W = [];
    for (let hour = 0; hour < 24; hour++) {
      const samples = buckets[month][hour];
      if (samples.length === 0) {
        meanW.push(null);
        p90W.push(null);
        continue;
      }
      const sorted = [...samples].sort((a, b) => a - b);
      meanW.push(round1(samples.reduce((s, x) => s + x, 0) / samples.length));
      p90W.push(round1(percentile(sorted, 0.9)));
    }
    const known = meanW.filter((w) => w !== null);
    const dailyKwh = known.length === 24 ? Number((known.reduce((s, w) => s + w, 0) / 1000).toFixed(3)) : null;
    months.push({
      month,
      meanW,
      p90W,
      dailyKwh,
      specificDailyKwhPerKwp: dailyKwh === null ? null : Number((dailyKwh / peakKw).toFixed(3)),
    });
  }
  return { hourBasis: 'local', timeZone, months };
}

async function main() {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const configPath = process.argv[2] ?? `${here}pvgis-config.json`;
  const outPath = process.argv[3] ?? `${here}pv-profile.json`;
  const envPath = `${here}../../.env`;
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const raw = (await readFile(configPath, 'utf8')).replace(/^﻿/, '');
  const checked = validateConfig(JSON.parse(raw));
  if (!checked.ok) throw new Error(`${checked.error.code}: ${checked.error.detail}`);
  const resolved = resolveLocation(checked.value, process.env);
  if (!resolved.ok) throw new Error(`${resolved.error.code}: ${resolved.error.detail}`);
  const config = resolved.value;
  const url = buildPvgisUrl(config);
  const res = await fetch(url, { signal: AbortSignal.timeout(config.api.timeoutMs) });
  if (!res.ok) throw new Error(`PVGIS HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const profile = typicalDayProfile(body.outputs.hourly, {
    timeZone: config.location.timeZone,
    peakKw: config.pv.peakKw,
  });
  const out = {
    source: publishedSource(config, body.inputs?.meteo_data?.radiation_db ?? null),
    ...profile,
  };
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote ${outPath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
