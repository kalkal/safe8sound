// @vitest-environment jsdom
import { LocationIdSchema, defaultUnitOf } from '@cold-reserve/contracts';
import { setLocale } from '@cold-reserve/i18n';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import * as fixtures from '../../src/fixtures.js';
import { RefusalReceipt } from '../../src/GuardReceipt.js';
import { PlanCard } from '../../src/PlanCard.js';
import { SafeRoomCard } from '../../src/SafeRoomCard.js';
import { setPlace } from '../../src/place-context.js';
import { setTempUnit } from '../../src/temp-unit.js';

// Golden (C0, 18 Oct): the card fixtures and the markup each card renders from them today, in each place with its own
// unit (Houston in °F), before the °F formulas and the places move to one catalog. Never regenerated in a migration
// PR (`-u`). The fixtures' times are on the reference home's clock.

const TZ = 'Europe/Rome';
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const html = (markup: string) => `${markup.replace(/></g, '>\n<')}\n`;

const PLANS = {
  hotDayPlan: fixtures.hotDayPlan,
  surplusPlan: fixtures.surplusPlan,
  stormPlan: fixtures.stormPlan,
  rejectedPlan: fixtures.rejectedPlan,
  lastResortPlan: fixtures.lastResortPlan,
  planThatHolds: fixtures.planThatHolds,
  advisoryPlan: fixtures.advisoryPlan,
} as const;
const SAFE_ROOMS = {
  safeRoomInStorm: fixtures.safeRoomInStorm,
  safeRoomCalm: fixtures.safeRoomCalm,
  safeRoomAboveNightLimit: fixtures.safeRoomAboveNightLimit,
  safeRoomBatteryFirst: fixtures.safeRoomBatteryFirst,
} as const;
const REFUSALS = { inverterRefusal: fixtures.inverterRefusal, stormReserveRefusal: fixtures.stormReserveRefusal } as const;

afterEach(() => {
  setTempUnit('C');
  setPlace(undefined);
  setLocale('en-US');
});

describe('golden: the card fixtures', () => {
  it('the fixture data', async () => {
    const data = {
      ...Object.fromEntries(Object.entries({ ...PLANS, ...SAFE_ROOMS, ...REFUSALS }).map(([name, make]) => [name, make()])),
      ...Object.fromEntries(LocationIdSchema.options.map((place) => [`lastResortBatteryPlan.${place}`, fixtures.lastResortBatteryPlan(place)])),
      'lastResortBatteryPlan.none': fixtures.lastResortBatteryPlan(),
    };
    await expect(json(data)).toMatchFileSnapshot('./__golden__/fixtures.json');
  });

  for (const place of LocationIdSchema.options) {
    it(`the cards in ${place}, in ${defaultUnitOf(place) === 'F' ? '°F' : '°C'}`, async () => {
      setPlace(place);
      setTempUnit(defaultUnitOf(place));
      const cards: string[] = [];
      for (const [name, make] of Object.entries(PLANS)) cards.push(`<!-- PlanCard ${name} -->`, renderToStaticMarkup(<PlanCard plan={make()} timeZone={TZ} onApply={() => undefined} />));
      cards.push('<!-- PlanCard lastResortBatteryPlan -->', renderToStaticMarkup(<PlanCard plan={fixtures.lastResortBatteryPlan(place)} timeZone={TZ} onApply={() => undefined} />));
      for (const [name, make] of Object.entries(SAFE_ROOMS)) cards.push(`<!-- SafeRoomCard ${name} -->`, renderToStaticMarkup(<SafeRoomCard status={make()} />));
      for (const [name, make] of Object.entries(REFUSALS)) cards.push(`<!-- RefusalReceipt ${name} -->`, renderToStaticMarkup(<RefusalReceipt refusal={make()} />));
      await expect(html(cards.join('\n'))).toMatchFileSnapshot(`./__golden__/cards.${place}.html`);
    });
  }
});
