import { HomeIdSchema, HomeProfileSchema, err, ok, toolError, type ErrorEnvelope, type HomeId, type Result } from '@cold-reserve/contracts';
import { scenarioClock, type Clock, type HomeDataSource } from '@cold-reserve/core';
import { FallbackSource } from '@cold-reserve/source-fallback';
import { SCENARIO_IDS, SimulatorSource, builtInScenario, defaultSimParams, demoProfile, type ScenarioId } from '@cold-reserve/source-simulator';
import { loadConfig, type ServerConfig } from './config.js';
import { createMcpHandler, type Logger, type McpHandler } from './handler.js';
import { energyStatusModule, interimStatusDeriver, type HomeEntry } from './modules/energy-status/index.js';
import { createRegistry, type CapabilityModule, type ModuleRegistry } from './registry.js';

export interface AppOptions {
  /** Wall clock; the simulator runs on scenario time derived from it (plan §9.4). */
  readonly wallClock: Clock;
  readonly logger: Logger;
  /** Extra capability modules after the built-in ones (tests; future modules register here). */
  readonly modules?: readonly CapabilityModule[];
  /** Tests only: replace a home's data source (fault injection). */
  readonly sourceOverride?: (homeId: HomeId) => HomeDataSource | undefined;
}

export interface App {
  readonly config: ServerConfig;
  readonly registry: ModuleRegistry;
  readonly handler: McpHandler;
}

const HOUR_MS = 3_600_000;
const DEMO = HomeIdSchema.parse('demo');
const HOME = HomeIdSchema.parse('home');

/** TODO(#15): the real home's source (home bridge + ingest). Until then the fallback always serves. */
const noLiveHome: HomeDataSource = {
  snapshot: () => Promise.resolve(err(toolError('home_data_stale', 'No live reading from the home yet.'))),
};

function number(env: Readonly<Record<string, string | undefined>>, key: string, fallback: number): Result<number, ErrorEnvelope> {
  const raw = env[key];
  // Number('') is 0: an empty value is a mistake, not a request for zero.
  const value = raw === undefined ? fallback : raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? ok(value) : err(toolError('invalid_config', `${key} must be a non-negative number.`));
}

/**
 * Composition root shared by the local Node entry and the Lambda entry (plan §9.2: dependencies
 * built by a factory, no DI framework). Homes: `demo` is the seeded simulator; `home` is the real
 * home behind FallbackSource, read-only, with the simulator as its declared fallback.
 */
export function createApp(env: Readonly<Record<string, string | undefined>>, opts: AppOptions): Result<App, ErrorEnvelope> {
  const config = loadConfig(env);
  if (!config.ok) return config;

  const scenarioId = env['MCP_SCENARIO'] ?? 'clear-day';
  if (!(SCENARIO_IDS as readonly string[]).includes(scenarioId)) {
    return err(toolError('invalid_config', `MCP_SCENARIO must be one of ${SCENARIO_IDS.join(', ')}.`));
  }
  const startH = number(env, 'MCP_SCENARIO_START_H', 0);
  const speed = number(env, 'MCP_SCENARIO_SPEED', 1);
  if (!startH.ok) return startH;
  if (!speed.ok) return speed;

  const scenario = builtInScenario(scenarioId as ScenarioId);
  const scenarioStartMs = Date.parse(scenario.startAt) + startH.value * HOUR_MS;
  const clock = scenarioClock({ wall: opts.wallClock, anchorMs: opts.wallClock.now(), scenarioStartMs, speed: speed.value });
  const params = defaultSimParams();
  const levelSince = new Date(scenarioStartMs).toISOString();

  const demo = demoProfile();
  const home = HomeProfileSchema.parse({ ...demo, homeId: HOME });
  const simulator = (profile: typeof demo) => new SimulatorSource({ profile, scenario, params, clock });
  const homes = new Map<HomeId, HomeEntry>([
    [DEMO, { source: simulator(demo), profile: demo, readOnly: false, levelSince }],
    [HOME, { source: new FallbackSource({ primary: noLiveHome, fallback: simulator(home), clock }), profile: home, readOnly: true, levelSince }],
  ]);

  const registry = createRegistry([
    energyStatusModule({
      homes: (homeId) => {
        const entry = homes.get(homeId);
        const override = opts.sourceOverride?.(homeId);
        return entry && override ? { ...entry, source: override } : entry;
      },
      deriver: interimStatusDeriver,
    }),
    ...(opts.modules ?? []),
  ]);
  if (!registry.ok) return registry;

  return ok({
    config: config.value,
    registry: registry.value,
    handler: createMcpHandler(config.value, { registry: registry.value, logger: opts.logger }),
  });
}
