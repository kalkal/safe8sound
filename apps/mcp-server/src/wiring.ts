import { ok, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import type { Clock, StateStoreFactory } from '@cold-reserve/core';
import type { App } from './app.js';
import { comfortPlanWiring, type ComfortPlanWiring } from './comfort-plan-config.js';
import { composeModules } from './compose.js';
import { withPlaythrough } from './playthrough.js';
import { loadPreferencesConfig, preferencesConfigFile } from './preferences-config.js';
import type { CapabilityModule } from './registry.js';
import { stormModeWiring, type StormModeWiring } from './storm-mode-config.js';

// The modules' wiring both entries share (#324): the local entry on its in-memory store, the Lambda entry on DynamoDB.
// Everything runs on the scenario clock; the store keeps the wall clock, for retention only (#175).

export interface WiredModules {
  readonly modules: CapabilityModule[];
  readonly stormMode: StormModeWiring;
  readonly comfortPlan: ComfortPlanWiring;
  /**
   * Hands the built app's per-home clock and unit to what was wired before it (late binding): the stores are scoped to
   * each home's playthrough, and preferences are stamped at its own time and said in its unit (C2b, #306).
   */
  readonly bind: (app: App) => void;
}

export function wireModules(o: { readonly store: StateStoreFactory; readonly clock: Clock }): Result<WiredModules, ErrorEnvelope> {
  // Before `bind` nothing has a home's clock or unit: a call then is a wiring bug, said loudly, never the wall clock or °C.
  const unbound = (): never => {
    throw new Error('wireModules: a home was used before bind(app)');
  };
  let homeClock: App['homeClock'] = unbound;
  let homeUnits: App['homeUnits'] = unbound;
  const storeFor = withPlaythrough(o.store, (homeId) => homeClock(homeId));
  const preferences = loadPreferencesConfig(preferencesConfigFile());
  if (!preferences.ok) return preferences;
  const { clock } = o;
  const modules = composeModules({ preferences: preferences.value, storeFor, clock, clockFor: (homeId) => homeClock(homeId), unitsFor: (homeId) => homeUnits(homeId) });
  if (!modules.ok) return modules;
  // The family phone's notifier and inbox (#24) live in the same store; comfort-plan alerts go through the same notifier.
  const stormMode = stormModeWiring({ storeFor, preferences: preferences.value, clock });
  if (!stormMode.ok) return stormMode;
  const comfortPlan = comfortPlanWiring({ storeFor, preferences: preferences.value, clock, notifier: stormMode.value.notifier });
  if (!comfortPlan.ok) return comfortPlan;
  return ok({
    modules: modules.value,
    stormMode: stormMode.value,
    comfortPlan: comfortPlan.value,
    bind: (app) => {
      homeClock = app.homeClock;
      homeUnits = app.homeUnits;
    },
  });
}
