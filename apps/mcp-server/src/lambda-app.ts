import type { ErrorEnvelope, Result } from '@cold-reserve/contracts';
import type { Clock, Logger, StateStoreFactory } from '@cold-reserve/core';
import { createApp, scenarioClockFor, type App } from './app.js';
import { comfortPlanWiring } from './comfort-plan-config.js';
import { composeModules } from './compose.js';
import { wallStamped } from './log-clock.js';
import { loadPreferencesConfig, preferencesConfigFile } from './preferences-config.js';
import { stormModeWiring } from './storm-mode-config.js';

// The Lambda entry's composition (#175), like the local one: the simulator, the plans, the storm sessions, the inbox and
// the preferences log run on the scenario clock, so plan times and safe-until fall on the scenario day. The DynamoDB
// store keeps the wall clock, which its TTL needs; plan and confirmation expiry are judged on the home's scenario time.
// Log lines are stamped on the wall clock, with the scenario time beside them (CE-20).

export function createLambdaApp(
  env: Readonly<Record<string, string | undefined>>,
  opts: { readonly wallClock: Clock; readonly logger: Logger; readonly storeFor: StateStoreFactory; readonly metrics?: (line: Record<string, unknown>) => void },
): Result<App, ErrorEnvelope> {
  const clock = scenarioClockFor(env, opts.wallClock);
  if (!clock.ok) return clock;
  const preferences = loadPreferencesConfig(preferencesConfigFile());
  if (!preferences.ok) return preferences;
  const modules = composeModules({ preferences: preferences.value, storeFor: opts.storeFor, clock: clock.value });
  if (!modules.ok) return modules;
  // The family phone's inbox lives in the same table (#24); its HTTP route is not served here.
  const stormMode = stormModeWiring({ storeFor: opts.storeFor, preferences: preferences.value, clock: clock.value });
  if (!stormMode.ok) return stormMode;
  const comfortPlan = comfortPlanWiring({ storeFor: opts.storeFor, preferences: preferences.value, clock: clock.value, notifier: stormMode.value.notifier });
  if (!comfortPlan.ok) return comfortPlan;
  // No cardDocuments yet: the built card bundle is not shipped with the function, so the Lambda serves
  // the tools without their ui:// cards. TODO(#104): ship the card bundle with the MCP Lambda.
  return createApp(env, {
    wallClock: opts.wallClock,
    scenarioClock: clock.value,
    logger: wallStamped(opts.logger, opts.wallClock),
    modules: modules.value,
    comfortPlan: comfortPlan.value,
    stormMode: stormMode.value,
    ...(opts.metrics === undefined ? {} : { metrics: opts.metrics }),
  });
}
