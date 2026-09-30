import type {
  ConfigChange,
  ErrorEnvelope,
  GuaranteeId,
  HomeId,
  Plan,
  PlanId,
  Preferences,
  Result,
  StormSession,
} from '@cold-reserve/contracts';

// StateStore port (plan §9.1, §14.1): preferences, plans, the config-change log and the guard
// rejection log of ONE home. A store is built only from a homeId, which the caller takes from the
// token, never from the client (§13.2). Adapters: store-memory (local, tests), store-dynamodb.

/** One plan the guard refused (feature queue item 5: "the guard blocked X proposals"). */
export interface GuardRejection {
  /** ISO 8601 time of the rejection. */
  readonly at: string;
  /** The guarantees that failed; never empty. */
  readonly failed: readonly GuaranteeId[];
  readonly planId?: PlanId;
}

export interface PlanApplication {
  readonly plan: Plan;
  /** True when the plan had already been applied: the original outcome is returned (idempotent). */
  readonly alreadyApplied: boolean;
}

/** Retention of what the store writes, in days (plan §3.2); from config. */
export interface StateStoreTtl {
  readonly planDays: number;
  readonly configChangeDays: number;
  readonly guardRejectionDays: number;
  readonly stormSessionDays: number;
}

export const DEFAULT_STATE_STORE_TTL: StateStoreTtl = { planDays: 30, configChangeDays: 90, guardRejectionDays: 90, stormSessionDays: 90 };

export interface StateStore {
  readonly homeId: HomeId;
  /** `undefined` when the home has no saved preferences yet. */
  getPreferences(): Promise<Result<Preferences | undefined, ErrorEnvelope>>;
  /** Replaces the preferences and records every confirmed change. */
  putPreferences(preferences: Preferences, changes: readonly ConfigChange[]): Promise<Result<void, ErrorEnvelope>>;
  /** Config changes still retained, oldest first. */
  listConfigChanges(): Promise<Result<ConfigChange[], ErrorEnvelope>>;
  /** Stores a new proposed plan; a plan id is written once. */
  savePlan(plan: Plan): Promise<Result<void, ErrorEnvelope>>;
  getPlan(planId: PlanId): Promise<Result<Plan, ErrorEnvelope>>;
  /**
   * Marks a proposed, unexpired plan as applied (conditional write). Applying it again returns
   * the stored outcome with `alreadyApplied: true`.
   */
  applyPlan(planId: PlanId): Promise<Result<PlanApplication, ErrorEnvelope>>;
  recordGuardRejection(rejection: GuardRejection): Promise<Result<void, ErrorEnvelope>>;
  /** Rejections still retained, newest first. */
  listGuardRejections(): Promise<Result<GuardRejection[], ErrorEnvelope>>;
  /** Creates or replaces a storm session (by id) of this home. */
  saveStormSession(session: StormSession): Promise<Result<void, ErrorEnvelope>>;
  /** The most recently started storm session still retained, if any. */
  getLatestStormSession(): Promise<Result<StormSession | undefined, ErrorEnvelope>>;
}

export type StateStoreFactory = (homeId: HomeId) => StateStore;
