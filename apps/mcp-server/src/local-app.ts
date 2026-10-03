import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import type { Clock, Logger } from '@cold-reserve/core';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { createApp, scenarioClockFor, type App } from './app.js';
import type { CardDocuments } from './cards.js';
import { comfortPlanWiring } from './comfort-plan-config.js';
import { composeModules } from './compose.js';
import { loadPreferencesConfig, preferencesConfigFile } from './preferences-config.js';
import { stormModeWiring, type StormModeWiring } from './storm-mode-config.js';

// The local entry's composition (#160, the E2E collaudo): the simulator, the plans, the storm sessions, the
// preferences log and the in-memory store all run on ONE scenario clock, so "now" is the same everywhere and a
// plan made now expires ten scenario minutes later. (On Lambda the store keeps the wall clock, which DynamoDB's
// TTL needs: domain times in scenario time there are a follow-up.)

export interface LocalApp {
  readonly app: App;
  readonly stormMode: StormModeWiring;
}

/** MCP_SCENARIO_START_SOC_PCT, local only: the battery at the scenario start, to reach the last resort. */
export function localStartSocPct(env: Readonly<Record<string, string | undefined>>): Result<number | undefined, ErrorEnvelope> {
  const raw = env['MCP_SCENARIO_START_SOC_PCT'];
  if (raw === undefined || raw === '') return ok(undefined);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) return err(toolError('invalid_config', 'MCP_SCENARIO_START_SOC_PCT must be a battery level from 0 to 100.'));
  return ok(value);
}

export function createLocalApp(
  env: Readonly<Record<string, string | undefined>>,
  opts: { readonly wallClock: Clock; readonly logger: Logger; readonly cardDocuments?: CardDocuments },
): Result<LocalApp, ErrorEnvelope> {
  const clock = scenarioClockFor(env, opts.wallClock);
  if (!clock.ok) return clock;
  const startSoc = localStartSocPct(env);
  if (!startSoc.ok) return startSoc;
  const preferences = loadPreferencesConfig(preferencesConfigFile());
  if (!preferences.ok) return preferences;
  const storeFor = memoryStateStoreFactory({ backing: createMemoryBacking(), clock: clock.value });
  const modules = composeModules({ preferences: preferences.value, storeFor, clock: clock.value });
  if (!modules.ok) return modules;
  const stormMode = stormModeWiring({ storeFor, preferences: preferences.value, clock: clock.value });
  if (!stormMode.ok) return stormMode;
  const comfortPlan = comfortPlanWiring({ storeFor, preferences: preferences.value, clock: clock.value, notifier: stormMode.value.notifier });
  if (!comfortPlan.ok) return comfortPlan;
  const app = createApp(env, {
    wallClock: opts.wallClock,
    scenarioClock: clock.value,
    logger: opts.logger,
    modules: modules.value,
    comfortPlan: comfortPlan.value,
    stormMode: stormMode.value,
    ...(startSoc.value === undefined ? {} : { scenarioStartSocPct: startSoc.value }),
    ...(opts.cardDocuments === undefined ? {} : { cardDocuments: opts.cardDocuments }),
  });
  if (!app.ok) return app;
  return ok({ app: app.value, stormMode: stormMode.value });
}
