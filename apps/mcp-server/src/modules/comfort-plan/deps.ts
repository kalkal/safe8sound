import type { ErrorEnvelope, Forecast, HomeId, HomeProfile, Preferences, Result, TempUnit } from '@cold-reserve/contracts';
import type { Clock, HomeDataSource, Logger, Notifier, SimParams, StateStoreFactory, StoreScope } from '@cold-reserve/core';
import type { GuardConfig } from '@cold-reserve/guard';
import type { ComfortPlanConfig } from './config.js';

/** What the module needs of a home. Built by the composition root. */
export interface ComfortHome {
  readonly source: HomeDataSource;
  /** The forecast the plan is projected on (cached weather, or the scenario's). */
  readonly forecast: () => Forecast;
  readonly profile: HomeProfile;
  /** The real home during the hackathon: plans are advice, and never built on simulated data. */
  readonly readOnly: boolean;
  /**
   * The home's own scenario clock (C2a, Refs #222), when the composition root runs domain times on scenario
   * time: a sandbox playing another scenario then plans on its own time. Absent: the module's clock.
   */
  readonly clock?: Clock;
  /** The temperature unit of the tool texts (#306): the sandbox's choice; °C when unset. */
  readonly units?: TempUnit;
}

/** The deps a tool call on `homeId` runs with: the home's own clock when it has one, else the module's. */
export function atHome<D extends { readonly clock: Clock; readonly homes: (homeId: HomeId) => ComfortHome | undefined }>(deps: D, homeId: HomeId): D {
  const clock = deps.homes(homeId)?.clock;
  return clock === undefined ? deps : { ...deps, clock };
}

/** Everything the comfort-plan module needs; built per server by the composition root (plan §9.2). */
export interface ComfortPlanDeps {
  readonly homes: (homeId: HomeId) => ComfortHome | undefined;
  /** F5's StateStore: plans (write once, conditional idempotent apply) and the guard's rejections. */
  readonly storeFor: StateStoreFactory;
  /** The saved preferences, or the config defaults for this home. */
  /** `scope`: the turn's correlation id, so a failing read is logged by the store with it (review of #354). */
  readonly preferencesFor: (homeId: HomeId, profile: HomeProfile, scope: StoreScope) => Promise<Result<Preferences, ErrorEnvelope>>;
  /** The store's clock: plan creation and expiry use the same time as the conditional write. */
  readonly clock: Clock;
  /** Projection physics (the simulator parameters, config). */
  readonly model: SimParams;
  readonly guard: GuardConfig;
  readonly config: ComfortPlanConfig;
  readonly newPlanId: () => string;
  /** The shared log (#111): failures the module survives, and the audit trail of a last resort. */
  readonly logger: Logger;
  /** The family phone (#24): the alert when a last resort is applied (#160). */
  readonly notifier: Notifier;
}
