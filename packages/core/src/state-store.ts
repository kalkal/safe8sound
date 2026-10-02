import {
  IsoDateTimeSchema,
  PlanIdSchema,
  toolError,
  type ConfigChange,
  type ErrorEnvelope,
  type GuaranteeId,
  type HomeId,
  type InboxMessage,
  type NewInboxMessage,
  type Plan,
  type PlanId,
  type Preferences,
  type Result,
  type StormSession,
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

/**
 * The first step of a last-resort apply (#160): the second yes must bring back the token. Only its SHA-256
 * is stored, never the token, with the hash of the plan it was issued for.
 */
export interface LastResortConfirmation {
  readonly planId: PlanId;
  /** SHA-256 of the token, 64 lowercase hex characters. */
  readonly tokenHash: string;
  /** SHA-256 of the plan the person heard, 64 lowercase hex characters. */
  readonly planHash: string;
  /** ISO 8601; the token works until the millisecond before. */
  readonly expiresAt: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** What is wrong with a confirmation before it is stored, if anything: the same check in every adapter. */
export function lastResortConfirmationProblem(c: LastResortConfirmation): ErrorEnvelope | undefined {
  const field = !SHA256_HEX.test(c.tokenHash)
    ? 'tokenHash'
    : !SHA256_HEX.test(c.planHash)
      ? 'planHash'
      : !IsoDateTimeSchema.safeParse(c.expiresAt).success
        ? 'expiresAt'
        : !PlanIdSchema.safeParse(c.planId).success
          ? 'planId'
          : undefined;
  return field === undefined ? undefined : toolError('invalid_input', 'A last-resort confirmation breaks its contract.', { details: { field } });
}

/** The one answer to a token that cannot be used: never says whether it was wrong, expired, used or unknown. */
export const invalidLastResortToken = (): ErrorEnvelope =>
  toolError('last_resort_token_invalid', 'This confirmation is not valid any more: ask for the plan again and confirm it twice.');

/** Retention of what the store writes, in days (plan §3.2); from config. */
export interface StateStoreTtl {
  readonly planDays: number;
  readonly configChangeDays: number;
  readonly guardRejectionDays: number;
  readonly stormSessionDays: number;
  /** The family phone's messages (#24): short-lived, they matter during one storm. */
  readonly inboxDays: number;
}

export const DEFAULT_STATE_STORE_TTL: StateStoreTtl = { planDays: 30, configChangeDays: 90, guardRejectionDays: 90, stormSessionDays: 90, inboxDays: 2 };

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
  /** Stores the confirmation of a last-resort plan; it replaces an earlier one of the same plan. */
  saveLastResortConfirmation(confirmation: LastResortConfirmation): Promise<Result<void, ErrorEnvelope>>;
  /**
   * Uses the confirmation once (conditional write): a wrong, expired, used or unknown token is
   * `last_resort_token_invalid`, never which of them.
   */
  consumeLastResortConfirmation(planId: PlanId, tokenHash: string): Promise<Result<LastResortConfirmation, ErrorEnvelope>>;
  recordGuardRejection(rejection: GuardRejection): Promise<Result<void, ErrorEnvelope>>;
  /** Rejections still retained, newest first. */
  listGuardRejections(): Promise<Result<GuardRejection[], ErrorEnvelope>>;
  /** Creates or replaces a storm session (by id) of this home. */
  saveStormSession(session: StormSession): Promise<Result<void, ErrorEnvelope>>;
  /** The most recently started storm session still retained, if any. */
  getLatestStormSession(): Promise<Result<StormSession | undefined, ErrorEnvelope>>;
  /** Keeps a delivered family message for the phone (#24); validated against InboxMessageSchema. */
  saveInboxMessage(message: NewInboxMessage): Promise<Result<void, ErrorEnvelope>>;
  /** The family messages still retained, newest first, at most `limit`. */
  listInbox(limit: number): Promise<Result<InboxMessage[], ErrorEnvelope>>;
}

/** What a store knows of the request it serves: its failures are logged with this correlation id (#111). */
export interface StoreScope {
  readonly correlationId?: string;
}

export type StateStoreFactory = (homeId: HomeId, scope?: StoreScope) => StateStore;
