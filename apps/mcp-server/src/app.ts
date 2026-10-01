import { HomeIdSchema, HomeProfileSchema, IsoDateTimeSchema, SandboxHomeIdSchema, err, ok, toolError, type ErrorEnvelope, type HomeId, type Result } from '@cold-reserve/contracts';
import { scenarioClock, utcDayStart, type Clock, type HomeDataSource } from '@cold-reserve/core';
import { FallbackSource } from '@cold-reserve/source-fallback';
import { SCENARIO_IDS, SimulatorSource, builtInScenario, defaultSimParams, demoProfile, type ScenarioId } from '@cold-reserve/source-simulator';
import { withCardResources, type CardDocuments } from './cards.js';
import { loadConfig, type ServerConfig } from './config.js';
import { createMcpHandler, type Logger, type McpHandler } from './handler.js';
import type { ComfortPlanWiring } from './comfort-plan-config.js';
import { comfortPlanModule } from './modules/comfort-plan/index.js';
import { energyStatusModule, interimStatusDeriver, type HomeEntry } from './modules/energy-status/index.js';
import { stormModeModule } from './modules/storm-mode/index.js';
import type { StormModeWiring } from './storm-mode-config.js';
import { createSandboxes } from './sandboxes.js';
import { createRegistry, type CapabilityModule, type ModuleRegistry } from './registry.js';

export interface AppOptions {
  /** Wall clock; the simulator runs on scenario time derived from it (plan §9.4). */
  readonly wallClock: Clock;
  readonly logger: Logger;
  /** Extra capability modules after the built-in ones (tests; future modules register here). */
  readonly modules?: readonly CapabilityModule[];
  /** Tests only: replace a home's data source (fault injection). */
  readonly sourceOverride?: (homeId: HomeId) => HomeDataSource | undefined;
  /** The comfort-plan module (#19): store, preferences, configs; registered over the same homes. */
  readonly comfortPlan?: ComfortPlanWiring;
  /** The storm-mode module (#23): store, preferences, config and the family phone; over the same homes. */
  readonly stormMode?: StormModeWiring;
  /** The ui:// card documents (#92): when given, the tools that show a card link it. */
  readonly cardDocuments?: CardDocuments;
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
/**
 * Which wall-clock instant is the start of the scenario (R1, 2026-10-01 architecture check):
 * `start` (default) = when this server starts, fine for one local process; `daily` = the start of
 * the UTC day, the same in every Lambda container; or a fixed ISO instant.
 */
function scenarioAnchor(raw: string | undefined, startedAtMs: number): Result<number | ((wallMs: number) => number), ErrorEnvelope> {
  if (raw === undefined || raw === 'start') return ok(startedAtMs);
  if (raw === 'daily') return ok(utcDayStart);
  const instant = IsoDateTimeSchema.safeParse(raw);
  return instant.success ? ok(Date.parse(instant.data)) : err(toolError('invalid_config', 'MCP_SCENARIO_ANCHOR must be start, daily or an ISO instant.'));
}

export function createApp(env: Readonly<Record<string, string | undefined>>, opts: AppOptions): Result<App, ErrorEnvelope> {
  const config = loadConfig(env);
  if (!config.ok) return config;

  const scenarioId = env['MCP_SCENARIO'] ?? 'clear-day';
  if (!(SCENARIO_IDS as readonly string[]).includes(scenarioId)) {
    return err(toolError('invalid_config', `MCP_SCENARIO must be one of ${SCENARIO_IDS.join(', ')}.`));
  }
  const startH = number(env, 'MCP_SCENARIO_START_H', 0);
  const sandboxTtlH = number(env, 'MCP_SANDBOX_TTL_H', 24);
  const sandboxMaxNew = number(env, 'MCP_SANDBOX_MAX_NEW_PER_DAY', 100);
  if (!sandboxTtlH.ok) return sandboxTtlH;
  if (!sandboxMaxNew.ok) return sandboxMaxNew;
  const speed = number(env, 'MCP_SCENARIO_SPEED', 1);
  if (!startH.ok) return startH;
  if (!speed.ok) return speed;

  const scenario = builtInScenario(scenarioId as ScenarioId);
  const scenarioStartMs = Date.parse(scenario.startAt) + startH.value * HOUR_MS;
  const anchor = scenarioAnchor(env['MCP_SCENARIO_ANCHOR'], opts.wallClock.now());
  if (!anchor.ok) return anchor;
  const clock = scenarioClock({ wall: opts.wallClock, anchorMs: anchor.value, scenarioStartMs, speed: speed.value });
  const params = defaultSimParams();
  const levelSince = new Date(scenarioStartMs).toISOString();

  const demo = demoProfile();
  const home = HomeProfileSchema.parse({ ...demo, homeId: HOME });
  const simulator = (profile: typeof demo) => new SimulatorSource({ profile, scenario, params, clock });
  const demoSim = simulator(demo);
  const homeSim = simulator(home);
  const homes = new Map<HomeId, HomeEntry>([
    [DEMO, { source: demoSim, profile: demo, readOnly: false, levelSince }],
    [HOME, { source: new FallbackSource({ primary: noLiveHome, fallback: homeSim, clock }), profile: home, readOnly: true, levelSince }],
  ]);
  // TODO(#15): the cached Open-Meteo forecast; until then every home plans on the scenario weather.
  const forecasts = new Map<HomeId, () => ReturnType<SimulatorSource['forecast']>>([
    [DEMO, () => demoSim.forecast()],
    [HOME, () => homeSim.forecast()],
  ]);
  // Visitor sandboxes (#101): a copy of the demo home per visitor, created on first use, 24 h TTL, daily cap.
  const sandboxes = createSandboxes({
    clock: opts.wallClock,
    ttlMs: sandboxTtlH.value * HOUR_MS,
    maxNewPerDay: sandboxMaxNew.value,
    create: (homeId) => {
      const sim = simulator(HomeProfileSchema.parse({ ...demo, homeId }));
      return { entry: { source: sim, profile: demo, readOnly: false, levelSince } satisfies HomeEntry, forecast: () => sim.forecast() };
    },
  });
  const sandboxFor = (homeId: HomeId) => (SandboxHomeIdSchema.safeParse(homeId).success ? sandboxes.get(homeId) : undefined);

  const homeFor = (homeId: HomeId) => {
    const entry = homes.get(homeId) ?? sandboxFor(homeId)?.entry;
    const override = opts.sourceOverride?.(homeId);
    return entry && override ? { ...entry, source: override } : entry;
  };

  const planningHome = (homeId: HomeId) => {
    const entry = homeFor(homeId);
    const forecast = forecasts.get(homeId) ?? sandboxFor(homeId)?.forecast;
    return entry && forecast ? { source: entry.source, forecast, profile: entry.profile, readOnly: entry.readOnly } : undefined;
  };

  const modules = [
    energyStatusModule({ homes: homeFor, deriver: interimStatusDeriver }),
    ...(opts.comfortPlan === undefined ? [] : [comfortPlanModule({ ...opts.comfortPlan, model: params, homes: planningHome })]),
    ...(opts.stormMode === undefined ? [] : [stormModeModule({ ...opts.stormMode, homes: planningHome })]),
    ...(opts.modules ?? []),
  ];
  const registry = createRegistry(opts.cardDocuments === undefined ? modules : withCardResources(modules, opts.cardDocuments));
  if (!registry.ok) return registry;

  return ok({
    config: config.value,
    registry: registry.value,
    handler: createMcpHandler(config.value, { registry: registry.value, logger: opts.logger, sandboxes }),
  });
}
