import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import stormModeFile from '../config/storm-mode.json' with { type: 'json' };
import { loadComfortPlanConfig } from '../src/comfort-plan-config.js';
import { parseStormModeConfig } from '../src/modules/storm-mode/config.js';
import { loadPreferencesConfig, preferencesConfigFile } from '../src/preferences-config.js';

// Every file of config/ parsed once, by the loader the app uses, with the values the product promises.
// The field rules of each file are tested next to its parser; the guard's own file in packages/guard.
const SHIPPED: readonly (readonly [file: string, load: () => unknown, values: object])[] = [
  [
    'comfort-plan.json',
    loadComfortPlanConfig,
    {
      comfort: {
        planTtlMinutes: 10,
        lastResortConfirmMinutes: 10,
        planner: {
          dutyCycles: expect.objectContaining({ 0: { onMinutes: 40, periodMinutes: 60 } }) as unknown,
          // The surplus tip tries its options in this order: longest washing cycle first (#219).
          householdTip: { options: [{ cycle: 'eco' }, { cycle: 'normal' }, { cycle: 'quick' }, { load: 'cooking' }] },
        },
      },
      guard: { reserve: { essentialLoadW: expect.any(Number) as unknown } },
    },
  ],
  ['storm-mode.json', () => parseStormModeConfig(structuredClone(stormModeFile)), { capHours: 24, stableGridMinutes: 10, minIntervalMinutes: 60, minReplySeconds: 30, inApp: { maxPerHome: 50 } }],
  [
    'preferences.json',
    () => loadPreferencesConfig(preferencesConfigFile()),
    {
      limits: { cooling: { maxC: { min: 24, max: 30, default: 27 } }, heating: { minC: { min: 16, max: 22, default: 18 } } },
      comfortC: { cooling: 25, heating: 20 },
      autoStormOnGridLoss: true,
      language: 'en-US',
    },
  ],
];

describe('shipped config files', () => {
  it('has a row for every file of config/', () => {
    expect(SHIPPED.map(([file]) => file).sort()).toEqual(readdirSync(join(import.meta.dirname, '..', 'config')).sort());
  });

  it.each(SHIPPED)('%s parses with its defaults', (_file, load, values) => {
    expect(load()).toMatchObject({ ok: true, value: values });
  });
});
