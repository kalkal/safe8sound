import { HomeIdSchema, HomeProfileSchema, IsoDateTimeSchema, SandboxHomeIdSchema, categoryOf, err, ok, pct, toolError, type ErrorEnvelope, type HomeId, type HomeProfile, type Result } from '@cold-reserve/contracts';
import { epsBaseLoadW, isTimeZone, localMidnightMs, scenarioClock, type Clock, type HomeDataSource } from '@cold-reserve/core';
import { FallbackSource, type SourceEvent } from '@cold-reserve/source-fallback';
import { SCENARIO_IDS, SimulatorSource, builtInPlace, builtInScenario, defaultSimParams, demoProfile, type Scenario, type ScenarioId } from '@cold-reserve/source-simulator';
import { withCardResources, type CardDocuments } from './cards.js';
import { loadConfig, type ServerConfig } from './config.js';
import { createMcpHandler, type Logger, type McpHandler } from './handler.js';
import type { ComfortPlanWiring } from './comfort-plan-config.js';
import { atHome } from './modules/comfort-plan/deps.js';
import { comfortPlanModule } from './modules/comfort-plan/index.js';
import { energyStatusModule, interimStatusDeriver, type HomeEntry } from './modules/energy-status/index.js';
import { stormModeModule, type StormModeDeps } from './modules/storm-mode/index.js';
import { familyReply } from './modules/storm-mode/tools.js';
import type { PhoneReplyHandler } from './phone-inbox.js';
import type { StormModeWiring } from './storm-mode-config.js';
import { createSandboxes } from './sandboxes.js';
import { createRegistry, type CapabilityModule, type ModuleRegistry } from './registry.js';

export interface AppOptions {
  /** Wall clock; the simulator runs on scenario time derived from it (plan §9.4). */
  readonly wallClock: Clock;
  readonly logger: Logger;
  /** Where the per-tool latency metric goes (EMF lines on Lambda); none locally (G6, #146). */
  readonly metrics?: (line: Record<string, unknown>) => void;
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
  /**
   * The scenario clock, when the caller built its store and modules on it (the local entry): one clock for
   * everything. Otherwise createApp derives it from the environment with `scenarioClockFor`.
   */
  readonly scenarioClock?: Clock;
  /** Local entry only: the battery at the scenario start, in % (MCP_SCENARIO_START_SOC_PCT), to reach the last resort. */
  readonly scenarioStartSocPct?: number;
}

/**
 * The one scenario clock (#160): scenario time from the wall clock, the scenario, its start hour, speed and
 * anchor. createApp and the local entry use this same definition, so the simulator, the plans, the storm
 * sessions and the local store agree on "now".
 */
export function scenarioClockFor(env: Readonly<Record<string, string | undefined>>, wall: Clock): Result<Clock, ErrorEnvelope> {
  const start = scenarioStartFor(env);
  if (!start.ok) return start;
  const timeline = scenarioTimelineFor(env, wall);
  if (!timeline.ok) return timeline;
  // The zone of the place the scenario is played in (L1, #217): the reference place until sandboxes choose theirs (C2).
  return timeline.value.clockFor({ startAt: start.value.scenario.startAt, tz: builtInPlace('reference').tz });
}

/** What every home's scenario clock shares: the anchor rule, the speed and the start hour (C2a, Refs #222). */
export interface ScenarioTimeline {
  /** The scenario clock of a home playing a scenario that starts at `startAt` in a place of zone `tz`. */
  clockFor(play: { readonly startAt: string; readonly tz: string }): Result<Clock, ErrorEnvelope>;
}

/**
 * One timeline per process: the same anchor (MCP_SCENARIO_ANCHOR, read once at start), speed and start hour
 * for every home, so every container and every home agree on how wall time maps to scenario time; each home
 * gets the clock of its own scenario start and its own place's midnight (a Houston sandbox reads Houston time).
 */
export function scenarioTimelineFor(env: Readonly<Record<string, string | undefined>>, wall: Clock): Result<ScenarioTimeline, ErrorEnvelope> {
  const speed = number(env, 'MCP_SCENARIO_SPEED', 1);
  if (!speed.ok) return speed;
  const startH = number(env, 'MCP_SCENARIO_START_H', 0);
  if (!startH.ok) return startH;
  const raw = env['MCP_SCENARIO_ANCHOR'];
  const startedAtMs = wall.now();
  // Validate the anchor rule once, on the reference place, so a bad setting fails at start.
  const check = scenarioAnchor(raw, startedAtMs, builtInPlace('reference').tz);
  if (!check.ok) return check;
  return ok({
    clockFor: ({ startAt, tz }) => {
      const anchor = scenarioAnchor(raw, startedAtMs, tz);
      if (!anchor.ok) return anchor;
      return ok(scenarioClock({ wall, anchorMs: anchor.value, scenarioStartMs: Date.parse(startAt) + startH.value * HOUR_MS, speed: speed.value }));
    },
  });
}

/** The scenario and the instant the server starts in it (its start plus MCP_SCENARIO_START_H): one definition. */
function scenarioStartFor(env: Readonly<Record<string, string | undefined>>): Result<{ scenario: Scenario; startMs: number }, ErrorEnvelope> {
  const scenarioId = env['MCP_SCENARIO'] ?? 'clear-day';
  if (!(SCENARIO_IDS as readonly string[]).includes(scenarioId)) {
    return err(toolError('invalid_config', `MCP_SCENARIO must be one of ${SCENARIO_IDS.join(', ')}.`));
  }
  const startH = number(env, 'MCP_SCENARIO_START_H', 0);
  if (!startH.ok) return startH;
  const scenario = builtInScenario(scenarioId as ScenarioId);
  return ok({ scenario, startMs: Date.parse(scenario.startAt) + startH.value * HOUR_MS });
}

export interface App {
  readonly config: ServerConfig;
  readonly registry: ModuleRegistry;
  readonly handler: McpHandler;
  /** The family phone's reply (POST /phone/reply, #24), over the storm module's own deps; absent without it. */
  readonly familyReply?: PhoneReplyHandler;
  /** A home's own scenario clock: for what is composed before the app, like the playthrough of its stores (#234). */
  readonly homeClock: (homeId: HomeId) => Clock | undefined;
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
 * `start` (default) = when this server starts, fine for one local process; `daily` = midnight in the
 * IANA zone of the place (T1: right in winter and on the days the clocks change, not the fixed offset of the
 * scenario's `startAt`), so the scenario clock reads the same hour as the home and every Lambda container agrees; or a fixed ISO instant. With a fixed instant (or a speed
 * above 1) the simulator stops at the end of the scenario. With `daily` the scenario jumps back 24 h at
 * midnight: a long-running local server replays the day again from its start.
 */
export function scenarioAnchor(raw: string | undefined, startedAtMs: number, placeTimeZone: string): Result<number | ((wallMs: number) => number), ErrorEnvelope> {
  if (raw === undefined || raw === 'start') return ok(startedAtMs);
  if (raw === 'daily') {
    if (!isTimeZone(placeTimeZone)) return err(toolError('invalid_config', 'The place of the scenario has no valid IANA time zone.'));
    return ok((wallMs) => localMidnightMs(wallMs, placeTimeZone));
  }
  const instant = IsoDateTimeSchema.safeParse(raw);
  return instant.success ? ok(Date.parse(instant.data)) : err(toolError('invalid_config', 'MCP_SCENARIO_ANCHOR must be start, daily or an ISO instant.'));
}

/**
 * Off grid the simulator, the guard and the storm safe hours read the EPS load from the home profile. A profile
 * without it gets no assumed figure: its storm calculations refuse (`missing_eps_load`), and start-up says so.
 */
export function warnMissingEpsLoad(profiles: readonly HomeProfile[], logger: Logger): void {
  for (const profile of profiles) {
    const eps = epsBaseLoadW(profile);
    if (eps.ok) continue;
    logger.log({
      ts: new Date().toISOString(),
      level: 'warn',
      component: 'mcp-server',
      code: 'missing_eps_load',
      category: 'internal',
      message: 'The home profile gives no epsBaseLoadW: a simulated home gives no readings, and storm calculations refuse, until it does.',
      correlationId: 'startup',
      homeId: profile.homeId,
    });
  }
}

/**
 * The real home's data source switching to the simulator and back, in the shared log (#113). Not tied to one
 * request (the source is read by many), so the correlation id names the link.
 */
export function logSourceEvent(logger: Logger, homeId: HomeId): (event: SourceEvent) => void {
  return (event) => {
    const base = { ts: event.at, component: 'mcp-server', correlationId: 'home-link', homeId, details: { event: event.type } } as const;
    if (event.type === 'HOME_REACHABLE') {
      logger.log({ ...base, level: 'info', message: 'The home answers again: live data is back.' });
    } else if (event.type === 'HOME_UNREACHABLE') {
      logger.log({
        ...base,
        level: 'warn',
        code: event.reason,
        category: categoryOf(event.reason),
        message: `The home's data is ${event.homeLink}: the simulator stands in, and every reply says so.`,
        ...(event.errorName === undefined ? {} : { errorName: event.errorName }),
        details: { event: event.type, homeLink: event.homeLink, ...(event.lastLiveAt === undefined ? {} : { lastLiveAt: event.lastLiveAt }) },
      });
    } else {
      logger.log({
        ...base,
        level: 'error',
        code: event.code,
        category: categoryOf(event.code),
        message: 'The simulator standing in for the home failed: no home data until it is fixed.',
        ...(event.errorName === undefined ? {} : { errorName: event.errorName }),
      });
    }
  };
}

/** The Protected Resource Metadata mode at start-up (#149): auto, fixed or off, never the URL itself. */
function logMetadataMode(config: ServerConfig, logger: Logger): void {
  const pr = config.protectedResource;
  const mode = pr === undefined ? 'off' : pr.resource === 'auto' ? 'auto' : 'fixed';
  logger.log({
    ts: new Date().toISOString(),
    level: 'info',
    component: 'mcp-server',
    message: `Protected resource metadata: ${mode}.`,
    correlationId: 'startup',
    details: { event: 'protected_resource_metadata', mode, authorizationServers: pr?.authorizationServers.length ?? 0 },
  });
}

export function createApp(env: Readonly<Record<string, string | undefined>>, opts: AppOptions): Result<App, ErrorEnvelope> {
  const config = loadConfig(env);
  if (!config.ok) return config;

  const start = scenarioStartFor(env);
  if (!start.ok) return start;
  const sandboxTtlH = number(env, 'MCP_SANDBOX_TTL_H', 24);
  const sandboxMaxNew = number(env, 'MCP_SANDBOX_MAX_NEW_PER_DAY', 100);
  if (!sandboxTtlH.ok) return sandboxTtlH;
  if (!sandboxMaxNew.ok) return sandboxMaxNew;

  const builtIn = start.value.scenario;
  const startSoc = opts.scenarioStartSocPct;
  if (startSoc !== undefined && startSoc < demoProfile().battery.minSocHwPct) {
    return err(toolError('invalid_config', `MCP_SCENARIO_START_SOC_PCT is below the hardware floor of ${String(demoProfile().battery.minSocHwPct)}%.`));
  }
  const scenario = startSoc === undefined ? builtIn : { ...builtIn, initial: { ...builtIn.initial, batterySocPct: pct(startSoc) } };
  const scenarioStartMs = start.value.startMs;
  const derived = opts.scenarioClock === undefined ? scenarioClockFor(env, opts.wallClock) : ok(opts.scenarioClock);
  if (!derived.ok) return derived;
  const clock = derived.value;
  const params = defaultSimParams();
  const levelSince = new Date(scenarioStartMs).toISOString();

  const demo = demoProfile();
  const home = HomeProfileSchema.parse({ ...demo, homeId: HOME });
  const simulator = (profile: typeof demo) => new SimulatorSource({ profile, scenario, params, clock });
  const demoSim = simulator(demo);
  const homeSim = simulator(home);
  warnMissingEpsLoad([demo, home], opts.logger);
  logMetadataMode(config.value, opts.logger);
  const homes = new Map<HomeId, HomeEntry>([
    [DEMO, { source: demoSim, profile: demo, readOnly: false, levelSince, clock }],
    [HOME, { source: new FallbackSource({ primary: noLiveHome, fallback: homeSim, clock, onEvent: logSourceEvent(opts.logger, HOME) }), profile: home, readOnly: true, levelSince, clock }],
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
      return { entry: { source: sim, profile: demo, readOnly: false, levelSince, clock } satisfies HomeEntry, forecast: () => sim.forecast() };
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
    // The home's clock goes to the modules where their domain runs on scenario time: both entries pass scenarioClock
    // (local-app, lambda-app, #175). A test composing modules on another clock passes none and keeps it.
    const homeClock = opts.scenarioClock !== undefined && entry?.clock !== undefined ? { clock: entry.clock } : {};
    return entry && forecast ? { source: entry.source, forecast, profile: entry.profile, readOnly: entry.readOnly, ...homeClock } : undefined;
  };

  const stormDeps: StormModeDeps | undefined = opts.stormMode === undefined ? undefined : { ...opts.stormMode, model: params, homes: planningHome, logger: opts.logger };
  const modules = [
    energyStatusModule({ homes: homeFor, deriver: interimStatusDeriver }),
    ...(opts.comfortPlan === undefined ? [] : [comfortPlanModule({ ...opts.comfortPlan, model: params, homes: planningHome, logger: opts.logger })]),
    ...(stormDeps === undefined ? [] : [stormModeModule(stormDeps)]),
    ...(opts.modules ?? []),
  ];
  const registry = createRegistry(opts.cardDocuments === undefined ? modules : withCardResources(modules, opts.cardDocuments));
  if (!registry.ok) return registry;

  return ok({
    config: config.value,
    registry: registry.value,
    handler: createMcpHandler(config.value, { registry: registry.value, logger: opts.logger, sandboxes, ...(opts.metrics === undefined ? {} : { metrics: opts.metrics }) }),
    ...(stormDeps === undefined ? {} : { familyReply: (input, ctx) => familyReply(atHome(stormDeps, ctx.homeId), input, ctx) }),
    homeClock: (homeId) => homeFor(homeId)?.clock,
  });
}
