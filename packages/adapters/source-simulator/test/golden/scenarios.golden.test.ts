import { LocationIdSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { SCENARIO_IDS, builtInPlace, builtInScenario, rawScript } from '../../src/index.js';

// Golden (C0, 18 Oct): the exact data each scenario plays in each place today, before scenarios and places move to one
// catalog. A migration PR must leave these files as they are: never regenerate them there (`-u`); a difference is
// either a bug of the migration or a change of behaviour the owner approves in its own PR.

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe('golden: the built-in scenarios and places', () => {
  for (const scenarioId of SCENARIO_IDS) {
    for (const placeId of LocationIdSchema.options) {
      it(`${scenarioId} in ${placeId}: the merged scenario`, async () => {
        await expect(json(builtInScenario(scenarioId, placeId))).toMatchFileSnapshot(`./__golden__/scenario.${scenarioId}.${placeId}.json`);
      });
    }
    it(`${scenarioId}: the script as stored`, async () => {
      await expect(json(rawScript(scenarioId))).toMatchFileSnapshot(`./__golden__/script.${scenarioId}.json`);
    });
  }

  for (const placeId of LocationIdSchema.options) {
    it(`${placeId}: the place as parsed`, async () => {
      await expect(json(builtInPlace(placeId))).toMatchFileSnapshot(`./__golden__/place.${placeId}.json`);
    });
  }
});
