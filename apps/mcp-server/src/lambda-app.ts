import { ok, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import type { Clock, Logger, StateStoreFactory } from '@cold-reserve/core';
import { createApp, scenarioPlayFor, type App } from './app.js';
import { wallStamped } from './log-clock.js';
import { createLocalHandler, createPhoneInboxHandler } from './phone-inbox.js';
import { wireModules } from './wiring.js';

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
  // The family phone's inbox lives in the same table (#24); its read route is served here for the visitor sandboxes
  // (#267): sim-api reads it with its sandbox phone token for the visitor's phone panel.
  const wired = wireModules({ store: opts.storeFor, clock });
  if (!wired.ok) return wired;
  const { modules, stormMode, comfortPlan } = wired.value;
  // No cardDocuments yet: the built card bundle is not shipped with the function, so the Lambda serves
  // the tools without their ui:// cards. TODO(#104): ship the card bundle with the MCP Lambda.
  const app = createApp(env, {
    wallClock: opts.wallClock,
    scenarioClock: clock,
    scenarioTimeline: play.value.timeline,
    settingsStoreFor: opts.storeFor,
    logger: wallStamped(opts.logger, opts.wallClock),
    modules,
    comfortPlan,
    stormMode,
    ...(opts.metrics === undefined ? {} : { metrics: opts.metrics }),
  });
  if (!app.ok) return app;
  wired.value.bind(app.value);
  // GET /phone/inbox (#267, approved in #267): read-only here, no reply path; the MCP paths are unchanged.
  const phone = createPhoneInboxHandler(app.value.config, { inbox: stormMode.inbox, admit: app.value.admitSandbox, logger: wallStamped(opts.logger, opts.wallClock) });
  return ok({ ...app.value, handler: createLocalHandler(app.value.handler, phone) });
}
