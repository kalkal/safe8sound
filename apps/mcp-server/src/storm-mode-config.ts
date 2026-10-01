import { randomBytes } from 'node:crypto';
import { StormIdSchema, ok, type ErrorEnvelope, type HomeId, type HomeProfile, type Preferences, type Result, type StormId } from '@cold-reserve/contracts';
import type { Clock, StateStoreFactory } from '@cold-reserve/core';
import { createInAppNotifier, type InAppNotifier } from '@cold-reserve/notifier-inapp';
import file from '../config/storm-mode.json' with { type: 'json' };
import { parseStormModeConfig, type StormModeConfig } from './modules/storm-mode/index.js';
import { defaultPreferencesFor, type PreferencesConfig } from './preferences-config.js';

// Wiring of the storm-mode module shared by the local and the Lambda entries: config/storm-mode.json,
// the preferences (saved or default), fresh storm ids and the simulated in-app phone, whose inbox lives
// in the same StateStore (#24), so any process can read it.

export interface StormModeWiring {
  readonly storeFor: StateStoreFactory;
  readonly preferencesFor: (homeId: HomeId, profile: HomeProfile) => Promise<Result<Preferences, ErrorEnvelope>>;
  readonly clock: Clock;
  readonly config: StormModeConfig;
  readonly notifier: InAppNotifier['notifier'];
  /** The simulated phone's inbox, for the web app and the E2E tests. */
  readonly inbox: InAppNotifier['inbox'];
  readonly newStormId: () => StormId;
}

/** 20 random letters and digits after `storm_`: inside StormIdSchema. */
const newStormId = (): StormId => StormIdSchema.parse(`storm_${randomBytes(15).toString('base64url').replace(/[-_]/g, 'x').slice(0, 20)}`);

export function stormModeWiring(opts: { storeFor: StateStoreFactory; preferences: PreferencesConfig; clock: Clock }): Result<StormModeWiring, ErrorEnvelope> {
  const config = parseStormModeConfig(structuredClone(file));
  if (!config.ok) return config;
  const phone = createInAppNotifier({ storeFor: opts.storeFor, maxPerHome: config.value.inApp.maxPerHome });
  if (!phone.ok) return phone;
  return ok({
    storeFor: opts.storeFor,
    preferencesFor: async (homeId, profile) => {
      const saved = await opts.storeFor(homeId).getPreferences();
      if (!saved.ok) return saved;
      return saved.value === undefined ? defaultPreferencesFor(opts.preferences, profile) : ok(saved.value);
    },
    clock: opts.clock,
    config: config.value,
    notifier: phone.value.notifier,
    inbox: phone.value.inbox,
    newStormId,
  });
}
