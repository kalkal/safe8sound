import { LocationIdSchema, ScenarioIdSchema, defaultUnitOf } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { CATALOGS, LOCALES, emergencyNumberOf } from '../../src/index.js';

// Golden (C0, 18 Oct): what each scenario and place is called in each language, and the unit and emergency number each
// place has, exactly as today, before scenarios and places move to one catalog. Never regenerated in a migration PR.

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe('golden: scenario and place names, units and emergency numbers', () => {
  it('every key about scenarios and places, in every language', async () => {
    const keys = Object.fromEntries(
      LOCALES.map((locale) => [locale, Object.fromEntries(Object.entries(CATALOGS[locale]).filter(([key]) => /^settings\.(?:scenario|place)\b/.test(key)).sort(([a], [b]) => a.localeCompare(b)))]),
    );
    await expect(json(keys)).toMatchFileSnapshot('./__golden__/settings-keys.json');
  });

  it('each place: its default unit and its emergency number; the scenario ids', async () => {
    const places = Object.fromEntries(LocationIdSchema.options.map((place) => [place, { unit: defaultUnitOf(place), emergency: emergencyNumberOf(place) }]));
    await expect(json({ scenarios: ScenarioIdSchema.options, places })).toMatchFileSnapshot('./__golden__/places.json');
  });
});
