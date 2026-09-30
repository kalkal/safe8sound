import type { ErrorEnvelope, Forecast, HomeId, HomeProfile, Preferences, Result } from '@cold-reserve/contracts';
import type { Clock, HomeDataSource, SimParams, StateStoreFactory } from '@cold-reserve/core';
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
}

/** Everything the comfort-plan module needs; built per server by the composition root (plan §9.2). */
export interface ComfortPlanDeps {
  readonly homes: (homeId: HomeId) => ComfortHome | undefined;
  /** F5's StateStore: plans (write once, conditional idempotent apply) and the guard's rejections. */
  readonly storeFor: StateStoreFactory;
  /** The saved preferences, or the config defaults for this home. */
  readonly preferencesFor: (homeId: HomeId, profile: HomeProfile) => Promise<Result<Preferences, ErrorEnvelope>>;
  /** The store's clock: plan creation and expiry use the same time as the conditional write. */
  readonly clock: Clock;
  /** Projection physics (the simulator parameters, config). */
  readonly model: SimParams;
  readonly guard: GuardConfig;
  readonly config: ComfortPlanConfig;
  readonly newPlanId: () => string;
}
