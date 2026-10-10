import { HomeIdSchema, PreferencesSchema, err, ok, toolError, type Forecast, type HomeId, type Preferences, type Snapshot } from '@cold-reserve/contracts';
import { examplePreferences } from '@cold-reserve/contracts/fixtures';
import { fixedClock, memoryLogger, type Clock, type Notifier, type StateStoreFactory, type StoreScope } from '@cold-reserve/core';
import { createInAppNotifier } from '@cold-reserve/notifier-inapp';
import { parseGuardConfig } from '@cold-reserve/guard';
import rawGuardConfig from '@cold-reserve/guard/config/guard.json' with { type: 'json' };
import { SimulatorSource, builtInScenario, defaultSimParams, demoProfile, type ScenarioId } from '@cold-reserve/source-simulator';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import rawComfortConfig from '../../config/comfort-plan.json' with { type: 'json' };
import { parseComfortPlanConfig } from '../../src/modules/comfort-plan/config.js';
import type { ComfortPlanDeps } from '../../src/modules/comfort-plan/deps.js';
import type { ToolContext } from '../../src/tool.js';

// Shared inputs for the comfort-plan tests: the seeded simulator at a scenario hour, a settable wall
// clock for the store (plan expiry), F5's in-memory StateStore, and the shipped configs.

export const H = 3_600_000;
export const MIN = 60_000;
export const DEMO = HomeIdSchema.parse('demo');
export const REAL = HomeIdSchema.parse('home');

export function settableClock(ms: number): Clock & { set(ms: number): void } {
  let now = ms;
  return { now: () => now, set: (m: number) => (now = m) };
}

export const preferences = PreferencesSchema.parse({ ...examplePreferences(), roomPriority: ['bedroom-1', 'bedroom-2', 'living', 'study'] });

export function guardConfig() {
  const c = parseGuardConfig(rawGuardConfig);
  if (!c.ok) throw new Error(c.error.message);
  return c.value;
}

export function comfortConfig() {
  const c = parseComfortPlanConfig(rawComfortConfig);
  if (!c.ok) throw new Error(c.error.message);
  return c.value;
}

/** A simulator scenario at hour `atH`, with every dependency of the module. */
export function world(id: ScenarioId, atH: number, over: { homeId?: HomeId; readOnly?: boolean; snapshot?: (s: Snapshot) => Snapshot; forecast?: (f: Forecast) => Forecast; preferences?: Preferences; failRejections?: boolean; notifier?: Notifier; storeWallMs?: number; units?: 'C' | 'F' } = {}) {
  const profile = demoProfile();
  const scenario = builtInScenario(id);
  const startMs = Date.parse(scenario.startAt);
  const scenarioMs = startMs + atH * H;
  const clock = settableClock(Date.parse('2026-09-30T10:00:00Z'));
  const sim = new SimulatorSource({ profile, scenario, params: defaultSimParams(), clock: fixedClock(scenarioMs) });
  // The store's own wall clock (#175): the same as the modules' unless a test sets the wall apart from the domain.
  const memory = memoryStateStoreFactory({ backing: createMemoryBacking(), clock: over.storeWallMs === undefined ? clock : fixedClock(over.storeWallMs) });
  const scopes: (StoreScope | undefined)[] = [];
  // Records what each store was opened for; optionally fails the refusal log, for fault injection.
  const storeFor: StateStoreFactory = (h, scope) => {
    scopes.push(scope);
    const store = memory(h, scope);
    if (!over.failRejections) return store;
    const failed = () => Promise.resolve(err(toolError('store_unavailable', 'The state store did not answer.')));
    return new Proxy(store, {
      get: (target, key) => {
        if (key === 'recordGuardRejection') return failed;
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  };
  const logger = memoryLogger();
  // The family phone (#24): the same in-app inbox storm mode writes to.
  const phone = createInAppNotifier({ storeFor: memory, maxPerHome: 20 });
  if (!phone.ok) throw new Error(phone.error.message);
  const homeId = over.homeId ?? DEMO;
  let snapshotOf = (h: HomeId): Snapshot => {
    const s = { ...sim.snapshotAt(scenarioMs), homeId: h };
    return over.snapshot ? over.snapshot(s) : s;
  };
  let n = 0;
  const deps: ComfortPlanDeps = {
    homes: (h) =>
      h === homeId
        ? {
            source: { snapshot: () => Promise.resolve(ok(snapshotOf(h))) },
            forecast: () => (over.forecast ? over.forecast(sim.forecast()) : sim.forecast()),
            profile: { ...profile, homeId: h },
            readOnly: over.readOnly ?? false,
            ...(over.units === undefined ? {} : { units: over.units }),
          }
        : undefined,
    storeFor,
    preferencesFor: () => Promise.resolve(ok(over.preferences ?? preferences)),
    clock,
    model: defaultSimParams(),
    guard: guardConfig(),
    config: comfortConfig(),
    logger,
    notifier: over.notifier ?? phone.value.notifier,
    newPlanId: () => `plan_test_${String(++n).padStart(4, '0')}`,
  };
  const ctx: ToolContext = { correlationId: 'test-correlation', clientId: 'test', homeId };
  const store = storeFor(homeId);
  /** Replace the snapshot the home returns from now on (the state changed meanwhile). */
  const setSnapshot = (f: (s: Snapshot) => Snapshot) => {
    const before = snapshotOf;
    snapshotOf = (h) => f(before(h));
  };
  const inbox = async () => {
    const listed = await phone.value.inbox(homeId);
    if (!listed.ok) throw new Error(listed.error.message);
    return listed.value;
  };
  return { deps, ctx, store, clock, profile, setSnapshot, logger, scopes, inbox };
}

