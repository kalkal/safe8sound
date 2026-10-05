import { fixedClock } from '@cold-reserve/core';
import { SCENARIO_IDS, builtInMonth, builtInPlace, builtInScenario, parseMonth, defaultSimParams, demoProfile, mergeScenario, parsePlace, profileAtPlace, rawScript } from '../src/index.js';
import { ScenarioSchema, SimulatorSource } from '../src/index.js';
import { describe, expect, it } from 'vitest';
import legacyClearDay from './fixtures/legacy/clear-day.json' with { type: 'json' };
import legacyHeatwave from './fixtures/legacy/heatwave.json' with { type: 'json' };
import legacyStorm from './fixtures/legacy/storm-blackout.json' with { type: 'json' };

// L1 (#217): a scenario is a script (what happens at home) played in a place (its real weather, zone and
// sun). The `reference` place keeps the numbers the scenarios had before the split, exactly.

const LEGACY = { 'clear-day': legacyClearDay, heatwave: legacyHeatwave, 'storm-blackout': legacyStorm } as const;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('the reference place keeps today numbers', () => {
  it.each(SCENARIO_IDS)('%s: script + reference place = the scenario as it was before the split', (id) => {
    expect(builtInScenario(id)).toEqual(ScenarioSchema.parse(LEGACY[id]));
  });

  it('gives the sandbox profile the place location (rounded coordinates, IANA zone)', () => {
    expect(profileAtPlace(demoProfile(), builtInPlace('reference')).location).toEqual({ latRounded: 41.9, lonRounded: 12.5, tz: 'Europe/Rome' });
  });
});

describe('Turin and Houston: real July 2024 days (L2, #247)', () => {
  it.each([
    ['turin', 'Europe/Rome', '+02:00'],
    ['houston', 'America/Chicago', '-05:00'],
  ] as const)('%s plays every script on its own day, in its own zone, with its source and its rules', (id, tz, offset) => {
    const place = builtInPlace(id);
    expect(place).toMatchObject({ id, tz, pvYieldFactor: 1, source: { license: 'CC BY 4.0' } });
    expect(place.source.name).toMatch(/Open-Meteo/);
    for (const scenarioId of SCENARIO_IDS) {
      expect(place.days[scenarioId].selectionRule).toMatch(/2024|by name/);
      const scenario = builtInScenario(scenarioId, id);
      expect(scenario.startAt.startsWith(place.days[scenarioId].date)).toBe(true);
      expect(scenario.startAt.endsWith(offset)).toBe(true);
    }
    expect(profileAtPlace(demoProfile(), place).location.tz).toBe(tz);
  });

  it("notes on Houston's storm day that the outage hours are the script's", () => {
    expect(builtInPlace('houston').days['storm-blackout'].note).toMatch(/script's/);
  });
});

describe('merging a script with a place', () => {
  const houston = () => {
    const place = clone(builtInPlace('reference')) as Record<string, unknown> & { days: Record<string, Record<string, unknown>> };
    return {
      ...place,
      id: 'houston',
      label: 'Houston, Texas',
      latRounded: 29.8,
      lonRounded: -95.4,
      tz: 'America/Chicago',
      days: { ...place.days, 'storm-blackout': { ...place.days['storm-blackout'], date: '2024-07-08', outage: { fromH: 2, toH: 20, cause: 'Hurricane Beryl' } } },
    };
  };

  it('starts the script at its local hour on the place day, in the place zone', () => {
    const place = parsePlace(houston());
    if (!place.ok) throw new Error(place.error.message);
    const merged = mergeScenario(rawScript('storm-blackout'), place.value, demoProfile());
    if (!merged.ok) throw new Error(merged.error.message);
    expect(merged.value.startAt).toBe('2024-07-08T12:00:00-05:00');
  });

  it('adds the place outage to the script outages', () => {
    const place = parsePlace(houston());
    if (!place.ok) throw new Error(place.error.message);
    const merged = mergeScenario(rawScript('storm-blackout'), place.value, demoProfile());
    if (!merged.ok) throw new Error(merged.error.message);
    expect(merged.value.gridOutages).toEqual([...(legacyStorm.gridOutages as { fromH: number; toH: number }[]), { fromH: 2, toH: 20 }]);
  });

  it('scales the sun by the place PV yield factor', () => {
    const place = parsePlace({ ...clone(builtInPlace('reference')), pvYieldFactor: 0.5 });
    if (!place.ok) throw new Error(place.error.message);
    const merged = mergeScenario(rawScript('clear-day'), place.value, demoProfile());
    if (!merged.ok) throw new Error(merged.error.message);
    const noon = legacyClearDay.hourly[12] as { irradianceWm2: number };
    expect(merged.value.hourly[12]?.irradianceWm2).toBe(noon.irradianceWm2 * 0.5);
  });

  it('refuses a place day whose hours do not match the script length: invalid_config naming the field', () => {
    const place = clone(builtInPlace('reference')) as { days: Record<string, { hourly: unknown[] }> };
    place.days['heatwave']?.hourly.pop();
    const parsed = parsePlace(place);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const merged = mergeScenario(rawScript('heatwave'), parsed.value, demoProfile());
    expect(merged).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(JSON.stringify(merged)).toContain('hourly');
  });

  it('plays the same scenario the same way for the same seed', async () => {
    const run = async () => {
      const scenario = builtInScenario('heatwave');
      const source = new SimulatorSource({ profile: demoProfile(), scenario, params: defaultSimParams(), clock: fixedClock(Date.parse(scenario.startAt) + 5 * 3_600_000) });
      return JSON.stringify(await source.snapshot());
    };
    expect(await run()).toBe(await run());
  });
});

describe('parsePlace: the place file, private to the simulator', () => {
  const reference = () => clone(builtInPlace('reference')) as Record<string, unknown>;

  it.each([
    ['coordinates with more than one decimal', { latRounded: 41.93 }],
    ['an invalid time zone', { tz: 'Europe/Romee' }],
    ['a fixed offset instead of a zone', { tz: '+02:00' }],
    ['an unknown place id', { id: 'paris' }],
    ['a PV yield factor of zero', { pvYieldFactor: 0 }],
  ])('refuses %s with invalid_config naming the field, never the content', (_case, change) => {
    const result = parsePlace({ ...reference(), ...change });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    const field = Object.keys(change)[0] ?? '';
    expect(JSON.stringify(result)).toContain(field);
    const value: unknown = Object.values(change)[0];
    if (typeof value === 'string') expect(JSON.stringify(result)).not.toContain(value);
  });

  it('keeps the rule that chose a real day, in words (L2): optional, so the reference place stays as it is', () => {
    const place = reference() as { days: Record<string, Record<string, unknown>> };
    const heatwave = place.days['heatwave'] ?? {};
    heatwave['selectionRule'] = 'The day of 2024-07 with the highest maximum 2 m temperature (00:00-23:00 local); ties: the earliest.';
    const parsed = parsePlace(place);
    expect(parsed.ok && parsed.value.days.heatwave.selectionRule).toMatch(/highest maximum/);
    heatwave['selectionRule'] = '';
    expect(parsePlace(place)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });

  it('keeps a one-line note on a day (L2): what the data does not say, for example whose outage hours they are', () => {
    const place = reference() as { days: Record<string, Record<string, unknown>> };
    const storm = place.days['storm-blackout'] ?? {};
    storm['note'] = "The outage hours are the scenario script's, not the real outage of that day.";
    const parsed = parsePlace(place);
    expect(parsed.ok && parsed.value.days['storm-blackout'].note).toMatch(/script's/);
    storm['note'] = 'x'.repeat(301);
    expect(parsePlace(place)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });

  it('needs the real day of every scenario', () => {
    const place = reference() as { days: Record<string, unknown> };
    delete place.days['heatwave'];
    expect(parsePlace(place)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});

describe('the July 2024 hours of Turin and Houston, for the nights study (D1, #247)', () => {
  it.each(['turin', 'houston'] as const)('%s: every hour of the month, in order, in the place zone, with its source', (id) => {
    const month = builtInMonth(id);
    expect(month).toMatchObject({ id, month: '2024-07', tz: builtInPlace(id).tz, source: { license: 'CC BY 4.0' } });
    expect(month.hourly).toHaveLength(744);
    expect(month.hourly[0]?.time).toBe('2024-07-01T00:00');
    expect(month.hourly.at(-1)?.time).toBe('2024-07-31T23:00');
  });

  it('refuses hours out of order or missing: invalid_config naming the field', () => {
    const month = clone(builtInMonth('turin')) as unknown as { hourly: { time: string }[] };
    month.hourly.splice(10, 1);
    expect(parseMonth(month)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});
