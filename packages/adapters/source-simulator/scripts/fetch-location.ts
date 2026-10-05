import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parsePlace, rawScript, SCENARIO_IDS } from '../src/index.js';
import { ArchiveSchema, archiveUrl, clearestDay, hottestDay, hoursOf, monthHours, placeDay, wettestNoonWindow, type Archive, type Selection } from './place-from-archive.js';

// L2: one-off, by hand: `node --import tsx scripts/fetch-location.ts <turin|houston>`. Fetches the place's July 2024
// from Open-Meteo's ERA5 archive, picks each scenario's day by the rules in place-from-archive.ts (written before any
// data was fetched), validates the file against the L1 schema and writes it. Never in CI, tests or the demo. It prints
// a summary only; it knows only city centres rounded to one decimal, never a home.

const MONTH = '2024-07';
const SOURCE = {
  name: 'Weather data by Open-Meteo.com (Historical Weather API, ERA5: Copernicus Climate Change Service)',
  url: 'https://open-meteo.com/',
  license: 'CC BY 4.0',
};

interface City {
  readonly label: string;
  readonly latRounded: number;
  readonly lonRounded: number;
  readonly tz: string;
  readonly storm: (archive: Archive) => Selection;
  /** A note on the storm day, when the data does not say it all. */
  readonly stormNote?: string;
}

const CITIES: Record<'turin' | 'houston', City> = {
  turin: { label: 'Turin, Italy', latRounded: 45.1, lonRounded: 7.7, tz: 'Europe/Rome', storm: (a) => wettestNoonWindow(hoursOf(a), MONTH) },
  houston: {
    label: 'Houston, Texas',
    latRounded: 29.8,
    lonRounded: -95.4,
    tz: 'America/Chicago',
    // By name, not by data: Hurricane Beryl made landfall in Texas early on 8 July 2024.
    storm: () => ({ date: '2024-07-07', rule: 'Hurricane Beryl, by name: the 24 hours from 12:00 on 7 July 2024, the day before its landfall in Texas.' }),
    stormNote: "The outage hours are the scenario script's, not the real outage of that day.",
  },
};

const FrameSchema = z.object({ startHour: z.number().int(), durationH: z.number().int() });

async function main(id: string): Promise<void> {
  if (id !== 'turin' && id !== 'houston') throw new Error('Usage: fetch-location.ts <turin|houston>');
  const city = CITIES[id];
  const response = await fetch(archiveUrl(city, MONTH), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`The archive answered HTTP ${String(response.status)}.`);
  const archive = ArchiveSchema.parse(await response.json());
  if (archive.timezone !== city.tz) throw new Error(`The archive answered in ${archive.timezone}, not ${city.tz}.`);

  const hours = hoursOf(archive);
  const selections = { 'clear-day': clearestDay(hours, MONTH), heatwave: hottestDay(hours, MONTH), 'storm-blackout': city.storm(archive) };
  const days = Object.fromEntries(
    SCENARIO_IDS.map((scenario) => {
      const day = placeDay(archive, city.tz, selections[scenario], FrameSchema.parse(rawScript(scenario)));
      return [scenario, scenario === 'storm-blackout' && city.stormNote !== undefined ? { ...day, note: city.stormNote } : day];
    }),
  );
  const retrievedAt = new Date().toISOString().slice(0, 10);
  const place = { schemaVersion: 1, id, label: city.label, latRounded: city.latRounded, lonRounded: city.lonRounded, tz: city.tz, source: { ...SOURCE, retrievedAt }, pvYieldFactor: 1, days };
  const checked = parsePlace(place);
  if (!checked.ok) throw new Error(checked.error.message);

  const dir = new URL('../locations/', import.meta.url);
  writeFileSync(fileURLToPath(new URL(`${id}.json`, dir)), `${JSON.stringify(place, null, 2)}\n`);
  const nights = { schemaVersion: 1, id, month: MONTH, tz: city.tz, source: { ...SOURCE, retrievedAt }, hourly: monthHours(archive, MONTH) };
  writeFileSync(fileURLToPath(new URL(`${id}.${MONTH}.json`, dir)), `${JSON.stringify(nights)}\n`);
  console.log(`${id}: clear-day ${selections['clear-day'].date}, heatwave ${selections.heatwave.date}, storm ${selections['storm-blackout'].date}; ${String(nights.hourly.length)} hours of ${MONTH}.`);
}

main(process.argv[2] ?? '').catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
