import { ok, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import type { Clock, Logger, StateStoreFactory } from '@cold-reserve/core';
import { createApp, scenarioPlayFor, type App } from './app.js';
import { comfortPlanWiring } from './comfort-plan-config.js';
import { composeModules } from './compose.js';
import { wallStamped } from './log-clock.js';
import { withPlaythrough } from './playthrough.js';
import { createLocalHandler, createPhoneInboxHandler } from './phone-inbox.js';
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
  const play = scenarioPlayFor(env, opts.wallClock);
  if (!play.ok) return play;
  const clock = play.value.clock;
  // The app knows each home's clock once built: its stores are scoped to its playthrough (#234) and preferences are
  // stamped at its own time (C2b).
  let homeClock: App['homeClock'] = () => undefined;
  let homeUnits: App['homeUnits'] = () => 'C';
  const storeFor = withPlaythrough(opts.storeFor, (homeId) => homeClock(homeId));
  const preferences = loadPreferencesConfig(preferencesConfigFile());
  if (!preferences.ok) return preferences;
  const modules = composeModules({ preferences: preferences.value, storeFor, clock, clockFor: (homeId) => homeClock(homeId), unitsFor: (homeId) => homeUnits(homeId) });
  if (!modules.ok) return modules;
  // The family phone's inbox lives in the same table (#24); its read route is served here for the visitor sandboxes
  // (#267): sim-api reads it with its sandbox phone token for the visitor's phone panel.
  const stormMode = stormModeWiring({ storeFor, preferences: preferences.value, clock });
  if (!stormMode.ok) return stormMode;
  const comfortPlan = comfortPlanWiring({ storeFor, preferences: preferences.value, clock, notifier: stormMode.value.notifier });
  if (!comfortPlan.ok) return comfortPlan;
  // No cardDocuments yet: the built card bundle is not shipped with the function, so the Lambda serves
  // the tools without their ui:// cards. TODO(#104): ship the card bundle with the MCP Lambda.
  const app = createApp(env, {
    wallClock: opts.wallClock,
    scenarioClock: clock,
    scenarioTimeline: play.value.timeline,
    settingsStoreFor: opts.storeFor,
    logger: wallStamped(opts.logger, opts.wallClock),
    modules: modules.value,
    comfortPlan: comfortPlan.value,
    stormMode: stormMode.value,
    ...(opts.metrics === undefined ? {} : { metrics: opts.metrics }),
  });
  if (!app.ok) return app;
  homeClock = app.value.homeClock;
  homeUnits = app.value.homeUnits;
  // GET /phone/inbox (#267, approved in #267): read-only here, no reply path; the MCP paths are unchanged.
  const phone = createPhoneInboxHandler(app.value.config, { inbox: stormMode.value.inbox, admit: app.value.admitSandbox, logger: wallStamped(opts.logger, opts.wallClock) });
  return ok({ ...app.value, handler: createLocalHandler(app.value.handler, phone) });
}
