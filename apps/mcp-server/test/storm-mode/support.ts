import { PreferencesSchema, StormIdSchema, ok, type HomeId, type HomeProfile, type Preferences, type Snapshot } from '@cold-reserve/contracts';
import { fixedClock, memoryLogger, type Notifier } from '@cold-reserve/core';
import { createInAppNotifier } from '@cold-reserve/notifier-inapp';
import { SimulatorSource, builtInScenario, defaultSimParams, demoProfile, type ScenarioId } from '@cold-reserve/source-simulator';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import rawStormConfig from '../../config/storm-mode.json' with { type: 'json' };
import { loadComfortPlanConfig } from '../../src/comfort-plan-config.js';
import { parseStormModeConfig } from '../../src/modules/storm-mode/config.js';
import type { StormModeDeps } from '../../src/modules/storm-mode/deps.js';
import type { ToolContext } from '../../src/tool.js';
import { DEMO, H, MIN, settableClock } from '../comfort-plan/support.js';

// Shared inputs for the storm-mode tests: the seeded simulator at a settable scenario hour, the wall
// clock of the store and the session, F5's in-memory store, the in-app phone and the shipped config.

export { DEMO, H, MIN };

export const WALL_START = Date.parse('2026-09-30T10:00:00Z');

/** The guard and planner settings the safe-room hold reads: the shipped files, as in production. */
export function comfortConfigs() {
  const c = loadComfortPlanConfig();
  if (!c.ok) throw new Error(c.error.message);
  return c.value;
}

export function stormConfig() {
  const c = parseStormModeConfig(rawStormConfig);
  if (!c.ok) throw new Error(c.error.message);
  return c.value;
}

/** Grandpa's safe room is bedroom-1 (demo profile); the daughter is the one registered contact. */
export const preferences: Preferences = PreferencesSchema.parse({
  schemaVersion: 1,
  comfortC: { cooling: 25, heating: 20 },
  safeRoomId: 'bedroom-1',
  roomPriority: ['bedroom-1', 'bedroom-2', 'living', 'study'],
  safety: { cooling: { maxC: 27 }, heating: { minC: 18 }, humidity: { minPct: 40, maxPct: 60 } },
  autoStormOnGridLoss: true,
  familyContacts: [{ role: 'daughter', name: 'Giulia Example', channel: 'in_app', handle: 'phone-daughter-1' }],
  language: 'en-US',
});

export interface WorldOptions {
  readonly preferences?: Preferences;
  readonly notifier?: Notifier;
  readonly snapshot?: (s: Snapshot) => Snapshot;
  /** Changes the demo home (the simulator and the module see the same profile). */
  readonly profile?: (p: HomeProfile) => HomeProfile;
}

/** The storm-blackout scenario at hour `atH` (the grid is down from 3 to 18.5), with every dependency. */
export function world(atH: number, over: WorldOptions = {}, id: ScenarioId = 'storm-blackout') {
  const profile = over.profile ? over.profile(demoProfile()) : demoProfile();
  const scenario = builtInScenario(id);
  const startMs = Date.parse(scenario.startAt);
  let scenarioMs = startMs + atH * H;
  const clock = settableClock(WALL_START);
  const sim = () => new SimulatorSource({ profile, scenario, params: defaultSimParams(), clock: fixedClock(scenarioMs) });
  const storeFor = memoryStateStoreFactory({ backing: createMemoryBacking(), clock });
  const phone = createInAppNotifier({ storeFor, maxPerHome: 20 });
  if (!phone.ok) throw new Error(phone.error.message);
  let n = 0;
  const snapshotOf = (h: HomeId): Snapshot => {
    const s = { ...sim().snapshotAt(scenarioMs), homeId: h };
    return over.snapshot ? over.snapshot(s) : s;
  };
  const logger = memoryLogger();
  const deps: StormModeDeps = {
    homes: (h) =>
      h === DEMO
        ? { source: { snapshot: () => Promise.resolve(ok(snapshotOf(h))) }, forecast: () => sim().forecast(), profile: { ...profile, homeId: h }, readOnly: false }
        : undefined,
    storeFor,
    preferencesFor: () => Promise.resolve(ok(over.preferences ?? preferences)),
    clock,
    config: stormConfig(),
    notifier: over.notifier ?? phone.value.notifier,
    newStormId: () => StormIdSchema.parse(`storm_test${String(++n).padStart(8, '0')}`),
    logger,
    model: defaultSimParams(),
    guard: comfortConfigs().guard,
    comfortConfig: comfortConfigs().comfort,
  };
  const ctx: ToolContext = { correlationId: 'test-correlation', clientId: 'test', homeId: DEMO };
  /** Moves the scenario to hour `h` and the wall clock by the same amount. */
  const advanceTo = (h: number) => {
    clock.set(clock.now() + (startMs + h * H - scenarioMs));
    scenarioMs = startMs + h * H;
  };
  return { deps, ctx, logs: logger.lines, store: storeFor(DEMO), clock, profile, inbox: async () => {
      const listed = await phone.value.inbox(DEMO);
      if (!listed.ok) throw new Error(listed.error.message);
      return listed.value;
    }, advanceTo, snapshot: () => snapshotOf(DEMO), forecast: () => sim().forecast() };
}
