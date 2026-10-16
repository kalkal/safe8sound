import { HomeIdSchema, HomeProfileSchema, SandboxHomeIdSchema, defaultUnitOf, err, ok, pct, toolError, type ErrorEnvelope, type HomeId, type Result, type SandboxSettings, type TempUnit } from '@cold-reserve/contracts';
import { darkWindow, type Clock, type HomeDataSource, type StateStoreFactory } from '@cold-reserve/core';
import { FallbackSource } from '@cold-reserve/source-fallback';
import { SimulatorSource, builtInPlace, builtInScenario, defaultSimParams, demoProfile, demoStoryProfile, profileAtPlace } from '@cold-reserve/source-simulator';
import { withCardResources, type CardDocuments } from './cards.js';
import { loadConfig, type ServerConfig } from './config.js';
import { createMcpHandler, type Logger, type McpHandler } from './handler.js';
import type { ComfortPlanWiring } from './comfort-plan-config.js';
import { atHome } from './modules/comfort-plan/deps.js';
import { comfortPlanModule } from './modules/comfort-plan/index.js';
import type { DemoClockDeps } from './modules/demo-clock.js';
import { demoSettingsModule, type SandboxChoices } from './modules/demo-settings.js';
import { energyStatusModule, interimStatusDeriver, type HomeEntry } from './modules/energy-status/index.js';
import { stormModeModule, type ClaimedTransition, type StormModeDeps } from './modules/storm-mode/index.js';
import { catchUpStorm, runStormDetector } from './modules/storm-mode/observe.js';
import { familyReply } from './modules/storm-mode/tools.js';
import type { PhoneReplyHandler } from './phone-inbox.js';
import type { StormModeWiring } from './storm-mode-config.js';
import { essentialAtOf, outagesOf } from './milestones.js';
import { createSandboxes, type Sandboxes } from './sandboxes.js';
import { sandboxStorm } from './sandbox-storm.js';
import { refreshFrom, shippedPlace, withHousehold, type SandboxPlay } from './sandbox-play.js';
import { createRegistry, type CapabilityModule, type ModuleRegistry } from './registry.js';
import { envNumber, scenarioStartFor, scenarioTimelineFor, type ScenarioTimeline } from './scenario-clock.js';
import { homeProfileOf, logClientScopes, logMetadataMode, logSourceEvent, warnMissingEpsLoad } from './startup-log.js';

// Where they lived before #319: the entries and tests still import them from here.
export { scenarioAnchor, scenarioClockFor, scenarioPlayFor, scenarioTimelineFor, type ScenarioTimeline } from './scenario-clock.js';
export { logSourceEvent, warnMissingEpsLoad } from './startup-log.js';

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
  /** The timeline the caller built `scenarioClock` from: the sandboxes' clocks come from the same one (C2b). */
  readonly scenarioTimeline?: ScenarioTimeline;
  /**
   * Where the visitors' sandbox settings live (C2b, #222). With it, every sandbox request reads its settings and the
   * demo-settings tools are served; without it (tests), sandboxes play the defaults.
   */
  readonly settingsStoreFor?: StateStoreFactory;
}

export interface App {
  readonly config: ServerConfig;
  readonly registry: ModuleRegistry;
  readonly handler: McpHandler;
  /** The family phone's reply (POST /phone/reply, #24), over the storm module's own deps; absent without it. */
  readonly familyReply?: PhoneReplyHandler;
  /** A home's own scenario clock, for what is composed before the app: its stores' playthrough (#234), preferences (C2b). */
  readonly homeClock: (homeId: HomeId) => Clock | undefined;
  /** A home's temperature unit for the tool texts (#306): the sandbox's choice; °C for the real home and demo. */
  readonly homeUnits: (homeId: HomeId) => TempUnit;
  /**
   * Admits a visitor sandbox and brings it up to date with its saved settings, as an MCP request does (#267): a
   * phone read in a fresh container then reads the inbox of the sandbox's own playthrough.
   */
  readonly admitSandbox: (homeId: HomeId, correlationId: string) => Promise<Result<void, ErrorEnvelope>>;
}

const HOUR_MS = 3_600_000;
const DEMO = HomeIdSchema.parse('demo');
const HOME = HomeIdSchema.parse('home');

/** TODO(#15): the real home's source (home bridge + ingest). Until then the fallback always serves. */
const noLiveHome: HomeDataSource = {
  snapshot: () => Promise.resolve(err(toolError('home_data_stale', 'No live reading from the home yet.'))),
};

/**
 * Composition root shared by the local Node entry and the Lambda entry (plan §9.2: dependencies
 * built by a factory, no DI framework). Homes: `demo` is the seeded simulator; `home` is the real
 * home behind FallbackSource, read-only, with the simulator as its declared fallback.
 */
export function createApp(env: Readonly<Record<string, string | undefined>>, opts: AppOptions): Result<App, ErrorEnvelope> {
  const config = loadConfig(env);
  if (!config.ok) return config;

  const start = scenarioStartFor(env);
  if (!start.ok) return start;
  const sandboxTtlH = envNumber(env, 'MCP_SANDBOX_TTL_H', 24);
  const sandboxMaxNew = envNumber(env, 'MCP_SANDBOX_MAX_NEW_PER_DAY', 100);
  const sandboxMaxAdvances = envNumber(env, 'MCP_SANDBOX_MAX_ADVANCES_PER_DAY', 30);
  if (!sandboxTtlH.ok) return sandboxTtlH;
  if (!sandboxMaxNew.ok) return sandboxMaxNew;
  if (!sandboxMaxAdvances.ok) return sandboxMaxAdvances;

  const builtIn = start.value.scenario;
  const startSoc = opts.scenarioStartSocPct;
  if (startSoc !== undefined && startSoc < demoProfile().battery.minSocHwPct) {
    return err(toolError('invalid_config', `MCP_SCENARIO_START_SOC_PCT is below the hardware floor of ${String(demoProfile().battery.minSocHwPct)}%.`));
  }
  const scenario = startSoc === undefined ? builtIn : { ...builtIn, initial: { ...builtIn.initial, batterySocPct: pct(startSoc) } };
  const scenarioStartMs = start.value.startMs;
  const timeline = opts.scenarioTimeline === undefined ? scenarioTimelineFor(env, opts.wallClock) : ok(opts.scenarioTimeline);
  if (!timeline.ok) return timeline;
  const reference = builtInPlace('reference');
  const derived = opts.scenarioClock === undefined ? timeline.value.clockFor({ startAt: builtIn.startAt, tz: reference.tz }) : ok(opts.scenarioClock);
  if (!derived.ok) return derived;
  const clock = derived.value;
  const params = defaultSimParams();
  const levelSince = new Date(scenarioStartMs).toISOString();
  const startHMs = scenarioStartMs - Date.parse(builtIn.startAt);

  const base = demoProfile();
  const demo = demoStoryProfile();
  // The real home never gets the demo's fictional names (#271): the schema refuses them there (R17).
  const homeProfile = homeProfileOf({ ...base, homeId: HOME, people: undefined }, opts.logger, 'startup');
  if (!homeProfile.ok) return homeProfile;
  const home = homeProfile.value;
  const simulator = (profile: typeof demo) => new SimulatorSource({ profile, scenario, params, clock });
  const demoSim = simulator(demo);
  const homeSim = simulator(home);
  warnMissingEpsLoad([demo, home], opts.logger);
  logMetadataMode(config.value, opts.logger);
  logClientScopes(config.value, opts.logger);
  const homes = new Map<HomeId, HomeEntry>([
    [DEMO, { source: demoSim, profile: demo, readOnly: false, levelSince, clock }],
    [HOME, { source: new FallbackSource({ primary: noLiveHome, fallback: homeSim, clock, onEvent: logSourceEvent(opts.logger, HOME) }), profile: home, readOnly: true, levelSince, clock }],
  ]);
  // TODO(#15): the cached Open-Meteo forecast; until then every home plans on the scenario weather.
  const forecasts = new Map<HomeId, () => ReturnType<SimulatorSource['forecast']>>([
    [DEMO, () => demoSim.forecast()],
    [HOME, () => homeSim.forecast()],
  ]);

  // Visitor sandboxes (#101) play their own settings (C2b, #222): the scenario, the place, who is at home and the
  // start of their day, each on its own scenario clock. Before any settings are saved, today's sandbox (Q3).
  // The reference home starts in its own unit (°C), the same rule as a later change of place.
  const sandboxDefaults: SandboxChoices = { scenarioId: start.value.scenarioId, locationId: 'reference', units: defaultUnitOf('reference'), household: 'older-man' };
  const playSandbox = (
    homeId: HomeId,
    choices: SandboxChoices & { readonly version?: number | undefined; readonly scenarioStartedAt?: string | undefined; readonly advancedMs?: number | undefined },
  ): Result<SandboxPlay, ErrorEnvelope> => {
    const place = shippedPlace(choices.locationId);
    const played = withHousehold(builtInScenario(choices.scenarioId, choices.locationId), choices.household);
    const sandboxScenario = startSoc === undefined ? played : { ...played, initial: { ...played.initial, batterySocPct: pct(startSoc) } };
    const homeClock = timeline.value.clockFor({
      startAt: sandboxScenario.startAt,
      tz: place.tz,
      ...(choices.scenarioStartedAt === undefined ? {} : { startedAtMs: Date.parse(choices.scenarioStartedAt) }),
      ...(choices.advancedMs === undefined ? {} : { advancedMs: choices.advancedMs }),
    });
    if (!homeClock.ok) return homeClock;
    const profile = profileAtPlace(demo, place);
    const sim = new SimulatorSource({ profile: HomeProfileSchema.parse({ ...profile, homeId }), scenario: sandboxScenario, params, clock: homeClock.value });
    const since = new Date(Date.parse(sandboxScenario.startAt) + startHMs).toISOString();
    return ok({
      entry: { source: sim, profile, readOnly: false, levelSince: since, clock: homeClock.value },
      forecast: () => sim.forecast(),
      units: choices.units,
      place: choices.locationId,
      scenario: sandboxScenario,
      startMs: Date.parse(sandboxScenario.startAt) + startHMs,
      ...(choices.version === undefined ? {} : { version: choices.version }),
    });
  };
  const settingsStoreFor = opts.settingsStoreFor;
  const sandboxes = createSandboxes<SandboxPlay, SandboxSettings>({
    clock: opts.wallClock,
    ttlMs: sandboxTtlH.value * HOUR_MS,
    maxNewPerDay: sandboxMaxNew.value,
    // The defaults always build: they are today's sandbox, checked at start-up below.
    create: (homeId) => {
      const play = playSandbox(homeId, sandboxDefaults);
      if (!play.ok) throw new Error(play.error.message);
      return play.value;
    },
    ...(settingsStoreFor === undefined ? {} : { refresh: refreshFrom(settingsStoreFor, playSandbox, opts.logger) }),
  });
  const startUp = playSandbox(DEMO, sandboxDefaults);
  if (!startUp.ok) return startUp;
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
    // The unit a visitor chose (#306), read with the settings on every request; the real home and demo say °C.
    const units = sandboxFor(homeId)?.units ?? 'C';
    // #376: the place of the emergency number: the visitor's choice; the demo and the real home are in Italy, the reference place.
    const place = sandboxFor(homeId)?.place ?? 'reference';
    return entry && forecast ? { source: entry.source, forecast, profile: entry.profile, readOnly: entry.readOnly, units, place, ...homeClock } : undefined;
  };

  // #379: a sandbox's storm start and power back belong to a scripted outage: its start names the alert, so every
  // container claims the same key and the family hears each once. The real home and demo claim nothing. #390: a storm
  // prepared belongs to the next outage not over yet (none ahead: nothing to claim, the session still opens once).
  const alertKey = (homeId: HomeId, transition: ClaimedTransition, nowMs: number): string | undefined => {
    const play = sandboxFor(homeId);
    if (play === undefined) return undefined;
    const all = outagesOf(play.scenario);
    const outage =
      transition === 'storm_prepared'
        ? all.filter((o) => o.toMs > nowMs).reduce<(typeof all)[number] | undefined>((first, o) => (first === undefined || o.fromMs < first.fromMs ? o : first), undefined)
        : all
            .filter((o) => (transition === 'storm_started' ? o.fromMs <= nowMs : o.toMs <= nowMs))
            .reduce<(typeof all)[number] | undefined>((latest, o) => (latest === undefined || o.fromMs > latest.fromMs ? o : latest), undefined);
    return outage === undefined ? undefined : `${transition}#${new Date(outage.fromMs).toISOString()}`;
  };
  const stormDeps: StormModeDeps | undefined = opts.stormMode === undefined ? undefined : { ...opts.stormMode, model: params, homes: planningHome, logger: opts.logger, alertKey };
  const stableGridMs = (opts.stormMode?.config.stableGridMinutes ?? 0) * 60_000;

  // #379: a sandbox's day runs on its own clock: each request that reads it checks its storm first, one pass at a time.
  const stormWatch = sandboxStorm({
    day: (homeId) => {
      const play = sandboxFor(homeId);
      const homeClock = play?.entry.clock;
      if (play === undefined || homeClock === undefined) return undefined;
      return { play, nowMs: homeClock.now(), outages: outagesOf(play.scenario) };
    },
    run: async (ctx, gridBackAtMs) => (stormDeps === undefined ? ok({ transitions: [], active: false }) : catchUpStorm(atHome(stormDeps, ctx.homeId), ctx, gridBackAtMs)),
    stableGridMs,
    logger: opts.logger,
    wallClock: opts.wallClock,
  });
  const watched: Sandboxes<SandboxPlay> = {
    admit: (homeId) => sandboxes.admit(homeId),
    get: (homeId) => sandboxes.get(homeId),
    refresh: async (homeId, correlationId) => {
      await sandboxes.refresh(homeId, correlationId);
      if (stormDeps !== undefined) await stormWatch.catchUp(homeId, correlationId);
    },
  };

  // The judges' clock (#311): a sandbox's day as played here, its plans, and the storm detector on its own clock.
  const comfortPlan = opts.comfortPlan;
  const demoClock: DemoClockDeps = {
    day: (homeId) => {
      const play = sandboxFor(homeId);
      if (play === undefined) return undefined;
      const { clock: homeClock, profile } = play.entry;
      if (homeClock === undefined) return undefined;
      const nowMs = homeClock.now();
      const essentialAt = essentialAtOf(play.scenario);
      const recharge =
        comfortPlan === undefined
          ? undefined
          : darkWindow({ forecast: play.forecast(), fromMs: nowMs, pvPeakW: profile.pvPeakW, lossRatio: params.pv.lossRatio, essentialLoadW: comfortPlan.guard.reserve.essentialLoadW });
      return {
        nowMs,
        version: play.version,
        anchorMs: homeClock.playthrough?.() ?? opts.wallClock.now(),
        startMs: play.startMs,
        endMs: Date.parse(play.scenario.startAt) + play.scenario.durationH * HOUR_MS,
        timeZone: profile.location.tz,
        outages: outagesOf(play.scenario),
        ...(recharge === undefined ? {} : { rechargeAtMs: recharge.toMs }),
        ...(essentialAt === undefined ? {} : { essentialAtMs: essentialAt }),
      };
    },
    getPlan: (homeId, planId, correlationId) =>
      comfortPlan === undefined ? Promise.resolve(err(toolError('plan_not_found', 'No such plan in this sandbox.'))) : comfortPlan.storeFor(homeId, { correlationId }).getPlan(planId),
    detect: async (ctx, kind) => {
      if (stormDeps === undefined) return ok(undefined);
      // After any catch-up pass of the same sandbox (#379): the family is told once even when both run at once.
      const ran = await stormWatch.serial(ctx.homeId, () => runStormDetector(atHome(stormDeps, ctx.homeId), ctx, kind));
      return ran.ok ? ok(undefined) : ran;
    },
    stableGridMs,
    maxAdvancesPerDay: sandboxMaxAdvances.value,
  };
  const modules = [
    energyStatusModule({ homes: homeFor, deriver: interimStatusDeriver }),
    ...(opts.comfortPlan === undefined ? [] : [comfortPlanModule({ ...opts.comfortPlan, model: params, homes: planningHome, logger: opts.logger })]),
    ...(stormDeps === undefined ? [] : [stormModeModule(stormDeps)]),
    ...(settingsStoreFor === undefined
      ? []
      : [
          demoSettingsModule({
            storeFor: settingsStoreFor,
            wallClock: opts.wallClock,
            defaults: sandboxDefaults,
            place: (id) => {
              const { label, tz } = shippedPlace(id);
              return { id, label, tz };
            },
            logger: opts.logger,
            // This container plays the change at once, as saved (no read, #406); the others at their next request.
            onChange: (homeId, settings, correlationId) => sandboxes.refresh(homeId, correlationId, settings),
            clock: demoClock,
          }),
        ]),
    ...(opts.modules ?? []),
  ];
  const registry = createRegistry(opts.cardDocuments === undefined ? modules : withCardResources(modules, opts.cardDocuments));
  if (!registry.ok) return registry;

  return ok({
    config: config.value,
    registry: registry.value,
    handler: createMcpHandler(config.value, { registry: registry.value, logger: opts.logger, sandboxes: watched, ...(opts.metrics === undefined ? {} : { metrics: opts.metrics }) }),
    ...(stormDeps === undefined ? {} : { familyReply: (input, ctx) => familyReply(atHome(stormDeps, ctx.homeId), input, ctx) }),
    homeClock: (homeId) => homeFor(homeId)?.clock,
    homeUnits: (homeId) => sandboxFor(homeId)?.units ?? 'C',
    admitSandbox: async (homeId, correlationId) => {
      const admitted = watched.admit(homeId);
      if (!admitted.ok) return admitted;
      // The family phone's read checks the storm too (#379): Ana's phone hears it even when the page asks nothing.
      await watched.refresh(homeId, correlationId);
      return ok(undefined);
    },
  });
}
