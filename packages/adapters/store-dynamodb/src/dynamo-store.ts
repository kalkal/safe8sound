import {
  ConfigChangeSchema,
  GuaranteeIdSchema,
  InboxMessageSchema,
  IsoDateTimeSchema,
  PlanIdSchema,
  PlanSchema,
  PreferencesSchema,
  StormSessionSchema,
  epochMs,
  err,
  ok,
  toolError,
  type ConfigChange,
  type ErrorEnvelope,
  type HomeId,
  type NewInboxMessage,
  type Plan,
  type PlanId,
  type Preferences,
  type Result,
  type StormSession,
} from '@cold-reserve/contracts';
import {
  DEFAULT_STATE_STORE_TTL,
  type Clock,
  type GuardRejection,
  type Rng,
  type PlanApplication,
  type StateStore,
  type StateStoreFactory,
  type StateStoreTtl,
} from '@cold-reserve/core';
import { z } from 'zod';
import type { TableClient, TableItem } from './table.js';

// StateStore on the single table (plan §3.2): PK = HOME#<homeId>; SK = PREFS | PLAN#<id> |
// EVENT#<ts>#<n> | GUARD#<ts>#<n>. Every item carries schemaVersion; logs and plans carry the
// DynamoDB TTL attribute `ttl` (epoch seconds). TTL deletion is lazy, so reads skip expired items.

const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60_000;
/** DynamoDB TransactWriteItems limit. */
const MAX_TRANSACTION_ITEMS = 100;

const GuardRejectionSchema = z.strictObject({
  at: IsoDateTimeSchema,
  failed: z.array(GuaranteeIdSchema).min(1),
  planId: PlanIdSchema.optional(),
});

export interface DynamoStateStoreOptions {
  readonly table: TableClient;
  readonly clock: Clock;
  readonly ttl?: StateStoreTtl;
  /** Randomness for unique log keys: injected, like the clock. */
  readonly rng: Rng;
  /** Receives every unexpected or transient failure with its cause, for the structured log. */
  readonly onError?: (event: StoreErrorEvent) => void;
}

export interface StoreErrorEvent {
  readonly code: 'store_unavailable' | 'unexpected_error';
  readonly operation: string;
  readonly cause: unknown;
}

export const dynamoStateStoreFactory =
  (options: DynamoStateStoreOptions): StateStoreFactory =>
  (homeId) =>
    new DynamoStateStore(homeId, options);

/** An expected outcome carried out of a #run body; converted back to a Result there. */
class Failure extends Error {
  constructor(readonly error: ErrorEnvelope) {
    super(error.message);
  }
}

class DynamoStateStore implements StateStore {
  readonly homeId: HomeId;
  readonly #table: TableClient;
  readonly #clock: Clock;
  readonly #rng: Rng;
  readonly #onError: ((event: StoreErrorEvent) => void) | undefined;
  readonly #ttl: StateStoreTtl;
  readonly #pk: string;
  #sequence = 0;

  constructor(homeId: HomeId, options: DynamoStateStoreOptions) {
    this.homeId = homeId;
    this.#table = options.table;
    this.#clock = options.clock;
    this.#rng = options.rng;
    this.#onError = options.onError;
    this.#ttl = options.ttl ?? DEFAULT_STATE_STORE_TTL;
    this.#pk = `HOME#${homeId}`;
  }

  getPreferences() {
    return this.#run('getPreferences', async () => {
      const item = await this.#table.get(this.#pk, 'PREFS');
      return item ? parse(PreferencesSchema, item) : undefined;
    });
  }

  putPreferences(preferences: Preferences, changes: readonly ConfigChange[]) {
    return this.#run('putPreferences', async () => {
      if (changes.some((change) => !IsoDateTimeSchema.safeParse(change.ts).success)) {
        fail(toolError('invalid_input', 'Every configuration change needs an ISO 8601 time.', { details: { field: 'changes' } }));
      }
      if (changes.length >= MAX_TRANSACTION_ITEMS) {
        fail(toolError('invalid_input', `At most ${String(MAX_TRANSACTION_ITEMS - 1)} changes at once.`, { details: { field: 'changes' } }));
      }
      // The log entries and the preferences land together or not at all.
      const events = changes.map((change) =>
        this.#item(`EVENT#${change.ts}#${this.#suffix()}`, change, epochMs(change.ts) + this.#ttl.configChangeDays * DAY_MS),
      );
      await this.#table.transactPut([...events, this.#item('PREFS', preferences)]);
    });
  }

  listConfigChanges() {
    return this.#run('listConfigChanges', async () => {
      const changes = (await this.#live('EVENT#')).map((item) => parse(ConfigChangeSchema, item));
      return changes.sort((a, b) => epochMs(a.ts) - epochMs(b.ts));
    });
  }

  savePlan(plan: Plan) {
    return this.#run('savePlan', async () => {
      const item = { ...this.#item(`PLAN#${plan.id}`, plan, epochMs(plan.createdAt) + this.#ttl.planDays * DAY_MS), status: plan.status, expiresAtMs: epochMs(plan.expiresAt) };
      const outcome = await this.#table.put(item, [{ attr: 'PK', op: 'not_exists' }]);
      if (outcome === 'condition_failed') {
        throw new Failure(toolError('invalid_input', `Plan ${plan.id} already exists; a plan id is written once.`, { details: { planId: plan.id } }));
      }
    });
  }

  getPlan(planId: PlanId) {
    return this.#run('getPlan', async () => (await this.#readPlan(planId)) ?? fail(notFound(planId)));
  }

  applyPlan(planId: PlanId): Promise<Result<PlanApplication, ErrorEnvelope>> {
    return this.#run('applyPlan', async () => {
      const plan = (await this.#readPlan(planId)) ?? fail(notFound(planId));
      if (plan.status === 'applied') return { plan, alreadyApplied: true };
      const nowMs = this.#clock.now();
      if (plan.status !== 'proposed' || nowMs >= epochMs(plan.expiresAt)) return fail(expired(planId));

      const applied: Plan = { ...plan, status: 'applied' };
      const outcome = await this.#table.update(this.#pk, `PLAN#${planId}`, { status: 'applied', data: applied }, [
        { attr: 'status', op: '=', value: 'proposed' },
        { attr: 'expiresAtMs', op: '>', value: nowMs },
      ]);
      if (outcome === 'ok') return { plan: applied, alreadyApplied: false };
      // Lost the race or the plan changed meanwhile: report what is stored now.
      const current = (await this.#readPlan(planId)) ?? fail(notFound(planId));
      return current.status === 'applied' ? { plan: current, alreadyApplied: true } : fail(expired(planId));
    });
  }

  recordGuardRejection(rejection: GuardRejection) {
    return this.#run('recordGuardRejection', async () => {
      if (rejection.failed.length === 0) {
        fail(toolError('invalid_input', 'A guard rejection names at least one failed guarantee.', { details: { field: 'failed' } }));
      }
      if (!IsoDateTimeSchema.safeParse(rejection.at).success) {
        fail(toolError('invalid_input', 'A guard rejection needs an ISO 8601 time.', { details: { field: 'at' } }));
      }
      await this.#table.put(this.#item(`GUARD#${rejection.at}#${this.#suffix()}`, rejection, epochMs(rejection.at) + this.#ttl.guardRejectionDays * DAY_MS));
    });
  }

  listGuardRejections() {
    return this.#run('listGuardRejections', async () => {
      const rejections = (await this.#live('GUARD#')).map((item): GuardRejection => {
        const { planId, ...rest } = parse(GuardRejectionSchema, item);
        return planId === undefined ? rest : { ...rest, planId };
      });
      return rejections.sort((a, b) => epochMs(b.at) - epochMs(a.at));
    });
  }

  saveStormSession(session: StormSession) {
    return this.#run('saveStormSession', async () => {
      if (session.homeId !== this.homeId) {
        fail(toolError('invalid_input', 'A storm session belongs to the home of the store.', { details: { field: 'homeId' } }));
      }
      await this.#table.put(this.#item(stormKey(session), session, epochMs(session.startedAt) + this.#ttl.stormSessionDays * DAY_MS));
    });
  }

  getLatestStormSession() {
    return this.#run('getLatestStormSession', async () => {
      // SK = STORM#<startedAt in UTC>#<id>: the newest session is the highest key, one item read.
      // If it has expired, every older one has too.
      const [latest] = await this.#table.query(this.#pk, 'STORM#', { newestFirst: true, limit: 1 });
      return latest && this.#isLive(latest) ? parse(StormSessionSchema, latest) : undefined;
    });
  }

  saveInboxMessage(message: NewInboxMessage) {
    return this.#run('saveInboxMessage', async () => {
      const parsed = InboxMessageSchema.safeParse(message);
      if (!parsed.success) {
        fail(toolError('invalid_input', 'A family message breaks its contract.', { details: { field: parsed.error.issues[0]?.path.join('.') ?? 'message' } }));
      }
      // SK = INBOX#<at in UTC>#<suffix>: newest first is the reverse key order; two messages at once are both kept.
      const sk = `INBOX#${new Date(message.at).toISOString()}#${this.#suffix()}`;
      await this.#table.put(this.#item(sk, message, epochMs(message.at) + this.#ttl.inboxDays * DAY_MS));
    });
  }

  listInbox(limit: number) {
    return this.#run('listInbox', async () => {
      if (limit <= 0) return [];
      // Expired messages are the oldest ones, so the live ones are a prefix of the newest-first page.
      const newest = await this.#table.query(this.#pk, 'INBOX#', { newestFirst: true, limit });
      return newest.filter((item) => this.#isLive(item)).map((item) => parse(InboxMessageSchema, item));
    });
  }

  async #readPlan(planId: PlanId): Promise<Plan | undefined> {
    const item = await this.#table.get(this.#pk, `PLAN#${planId}`);
    return item && this.#isLive(item) ? parse(PlanSchema, item) : undefined;
  }

  async #live(prefix: string): Promise<TableItem[]> {
    return (await this.#table.query(this.#pk, prefix)).filter((item) => this.#isLive(item));
  }

  #isLive(item: TableItem): boolean {
    return typeof item['ttl'] !== 'number' || this.#clock.now() < item['ttl'] * 1000;
  }

  #item(sk: string, data: unknown, expiresAtMs?: number): TableItem {
    return {
      PK: this.#pk,
      SK: sk,
      schemaVersion: SCHEMA_VERSION,
      data,
      ...(expiresAtMs !== undefined && { ttl: Math.ceil(expiresAtMs / 1000) }),
    };
  }

  /** Unique within this store instance and across instances: time + counter + injected randomness. */
  #suffix(): string {
    this.#sequence += 1;
    const random = Math.floor(this.#rng.next() * 36 ** 6).toString(36).padStart(6, '0');
    return `${String(this.#clock.now())}-${String(this.#sequence)}-${random}`;
  }

  async #run<T>(operation: string, body: () => Promise<T>): Promise<Result<T, ErrorEnvelope>> {
    try {
      return ok(await body());
    } catch (error) {
      if (error instanceof Failure) return err(error.error);
      // Only the table and the network fail transiently; anything else is a bug and must not be retried.
      const code = isTransient(error) ? 'store_unavailable' : 'unexpected_error';
      this.#onError?.({ code, operation, cause: error });
      return err(
        code === 'store_unavailable'
          ? toolError('store_unavailable', 'The saved settings are not reachable right now; try again shortly.')
          : toolError('unexpected_error', 'Something went wrong while reading or saving the settings.'),
      );
    }
  }
}

/** Throttling and capacity errors: DynamoDB asks the caller to slow down and retry. */
const TRANSIENT_NAMES = new Set(['ThrottlingException', 'ProvisionedThroughputExceededException', 'RequestLimitExceeded', 'TimeoutError', 'NetworkingError']);
/** Transaction cancellation reasons that a retry can fix; any other reason (validation, condition) cannot. */
const TRANSIENT_CANCELLATIONS = new Set(['TransactionConflict', 'ThrottlingError', 'ProvisionedThroughputExceeded']);

interface SdkErrorShape {
  name?: unknown;
  code?: unknown;
  $retryable?: unknown;
  $fault?: unknown;
  $metadata?: { httpStatusCode?: unknown };
  CancellationReasons?: Array<{ Code?: unknown }>;
}

/**
 * Transient only when a retry can help: the SDK marks it retryable, a server fault, HTTP 429 or 5xx,
 * a throttling name, a conflicting transaction, or a Node network error. ValidationException,
 * AccessDenied, ResourceNotFound and validation-type cancellations are bugs or configuration.
 */
function isTransient(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as SdkErrorShape;
  if (e.name === 'TransactionCanceledException') {
    const codes = (e.CancellationReasons ?? []).map((r) => r.Code).filter((code) => code !== 'None');
    return codes.length > 0 && codes.every((code) => typeof code === 'string' && TRANSIENT_CANCELLATIONS.has(code));
  }
  if (e.$retryable !== undefined || e.$fault === 'server') return true;
  const status = e.$metadata?.httpStatusCode;
  if (typeof status === 'number' && (status === 429 || status >= 500)) return true;
  if (typeof e.name === 'string' && TRANSIENT_NAMES.has(e.name)) return true;
  return typeof e.code === 'string' && /^E(CONN|TIMEDOUT|AI_AGAIN|PIPE|NOTFOUND|HOSTUNREACH|NETUNREACH)/.test(e.code);
}

function parse<T>(schema: z.ZodType<T>, item: TableItem): T {
  if (item['schemaVersion'] !== SCHEMA_VERSION) {
    throw new Failure(
      toolError('unexpected_error', `Stored item ${item.SK} has schemaVersion ${String(item['schemaVersion'])}; this version reads ${String(SCHEMA_VERSION)}.`),
    );
  }
  const parsed = schema.safeParse(item['data']);
  if (!parsed.success) {
    throw new Failure(toolError('unexpected_error', `Stored item ${item.SK} does not match its schema.`));
  }
  return parsed.data;
}

/** Sort key of a storm session (plan §3.2): the start time in UTC orders the sessions, the id keeps it unique. */
const stormKey = (session: StormSession) => `STORM#${new Date(session.startedAt).toISOString()}#${session.id}`;

function fail(error: ErrorEnvelope): never {
  throw new Failure(error);
}

const notFound = (planId: PlanId) => toolError('plan_not_found', `No plan ${planId} for this home.`, { details: { planId } });
const expired = (planId: PlanId) => toolError('plan_expired', 'This plan has expired; ask for a new one.', { details: { planId } });
