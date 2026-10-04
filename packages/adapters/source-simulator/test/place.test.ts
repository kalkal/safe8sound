import { fixedClock } from '@cold-reserve/core';
import { SCENARIO_IDS, builtInPlace, builtInScenario, defaultSimParams, demoProfile, mergeScenario, parsePlace, profileAtPlace, rawScript } from '../src/index.js';
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

  it('needs the real day of every scenario', () => {
    const place = reference() as { days: Record<string, unknown> };
    delete place.days['heatwave'];
    expect(parsePlace(place)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});
