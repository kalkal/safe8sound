import { randomBytes } from 'node:crypto';
import { err, ok, toolError, type ErrorEnvelope, type HomeId, type HomeProfile, type Preferences, type Result } from '@cold-reserve/contracts';
import type { Clock, Notifier, StateStoreFactory } from '@cold-reserve/core';
import { parseGuardConfig, type GuardConfig } from '@cold-reserve/guard';
import guardFile from '@cold-reserve/guard/config/guard.json' with { type: 'json' };
import file from '../config/comfort-plan.json' with { type: 'json' };
import { parseComfortPlanConfig, type ComfortPlanConfig } from './modules/comfort-plan/index.js';
import { defaultPreferencesFor, type PreferencesConfig } from './preferences-config.js';

// Wiring of the comfort-plan module shared by the local and the Lambda entries: the shipped configs
// (config/comfort-plan.json and the guard's), the preferences (saved or default) and fresh plan ids.
// The homes come from createApp, which owns the data sources.

export function loadComfortPlanConfig(): Result<{ comfort: ComfortPlanConfig; guard: GuardConfig }, ErrorEnvelope> {
  const comfort = parseComfortPlanConfig(structuredClone(file));
  if (!comfort.ok) return comfort;
  const guard = parseGuardConfig(structuredClone(guardFile));
  if (!guard.ok) return guard;
  // The outlook's saver load is an average of a whole level: it cannot be below Essential.
  if (comfort.value.outlook.levelLoadW.saver < guard.value.reserve.essentialLoadW) {
    return err(toolError('invalid_config', 'outlook.levelLoadW.saver in config/comfort-plan.json is below the essential load of the guard.'));
  }
  return ok({ comfort: comfort.value, guard: guard.value });
}

export interface ComfortPlanWiring {
  readonly storeFor: StateStoreFactory;
  readonly preferencesFor: (homeId: HomeId, profile: HomeProfile) => Promise<Result<Preferences, ErrorEnvelope>>;
  readonly clock: Clock;
  readonly config: ComfortPlanConfig;
  readonly guard: GuardConfig;
  readonly newPlanId: () => string;
  /** The family phone storm mode writes to: the alert of an applied last resort (#160). */
  readonly notifier: Notifier;
}

/** 20 random letters and digits after `plan_`: unguessable, and inside PlanIdSchema. */
const newPlanId = (): string => `plan_${randomBytes(15).toString('base64url').replace(/[-_]/g, 'x').slice(0, 20)}`;

export function comfortPlanWiring(opts: { storeFor: StateStoreFactory; preferences: PreferencesConfig; clock: Clock; notifier: Notifier }): Result<ComfortPlanWiring, ErrorEnvelope> {
  const config = loadComfortPlanConfig();
  if (!config.ok) return config;
  return ok({
    storeFor: opts.storeFor,
    preferencesFor: async (homeId, profile) => {
      const saved = await opts.storeFor(homeId).getPreferences();
      if (!saved.ok) return saved;
      return saved.value === undefined ? defaultPreferencesFor(opts.preferences, profile, homeId) : ok(saved.value);
    },
    clock: opts.clock,
    config: config.value.comfort,
    guard: config.value.guard,
    newPlanId,
    notifier: opts.notifier,
  });
}
