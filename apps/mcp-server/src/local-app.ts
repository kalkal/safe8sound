import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import type { Clock, Logger } from '@cold-reserve/core';
import { createMemoryBacking, memoryStateStoreFactory, type MemoryBacking } from '@cold-reserve/store-memory';
import { createApp, scenarioPlayFor, type App } from './app.js';
import type { CardDocuments } from './cards.js';
import { wallStamped } from './log-clock.js';
import type { StormModeWiring } from './storm-mode-config.js';
import { wireModules } from './wiring.js';

// The local entry's composition (#160, the end-to-end acceptance test): the simulator, the plans, the storm sessions and
// the preferences log all run on ONE scenario clock, so "now" is the same everywhere and a plan made now expires
// ten scenario minutes later. The in-memory store keeps the wall clock, for retention only. The Lambda entry
// (lambda-app.ts) runs its domain on the same scenario clock, and its DynamoDB store on the wall clock (#175).

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
  opts: {
    readonly wallClock: Clock;
    readonly logger: Logger;
    readonly cardDocuments?: CardDocuments;
    /** The store's data: a test shares one between two servers, as Lambda containers share DynamoDB (#449). */
    readonly backing?: MemoryBacking;
  },
): Result<LocalApp, ErrorEnvelope> {
  const play = scenarioPlayFor(env, opts.wallClock);
  if (!play.ok) return play;
  const clock = play.value.clock;
  const startSoc = localStartSocPct(env);
  if (!startSoc.ok) return startSoc;
  // The store's clock is the wall's: it drives only the retention; plan expiry is judged on the home's scenario time (#175).
  const memory = memoryStateStoreFactory({ backing: opts.backing ?? createMemoryBacking(), clock: opts.wallClock });
  const wired = wireModules({ store: memory, clock });
  if (!wired.ok) return wired;
  const { modules, stormMode, comfortPlan } = wired.value;
  const app = createApp(env, {
    wallClock: opts.wallClock,
    scenarioClock: clock,
    scenarioTimeline: play.value.timeline,
    // Settings belong to the sandbox, not to a playthrough of its day.
    settingsStoreFor: memory,
    logger: wallStamped(opts.logger, opts.wallClock),
    modules,
    comfortPlan,
    stormMode,
    ...(startSoc.value === undefined ? {} : { scenarioStartSocPct: startSoc.value }),
    ...(opts.cardDocuments === undefined ? {} : { cardDocuments: opts.cardDocuments }),
  });
  if (!app.ok) return app;
  wired.value.bind(app.value);
  return ok({ app: app.value, stormMode });
}
