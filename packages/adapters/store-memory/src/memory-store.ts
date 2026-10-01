import {
  InboxMessageSchema,
  IsoDateTimeSchema,
  PlanSchema,
  PreferencesSchema,
  StormSessionSchema,
  readStored,
  epochMs,
  err,
  ok,
  toolError,
  type ConfigChange,
  type ErrorEnvelope,
  type HomeId,
  type InboxMessage,
  type NewInboxMessage,
  type Plan,
  type PlanId,
  type Preferences,
  type Result,
  type StormSession,
  type StoredSchema,
} from '@cold-reserve/contracts';
import {
  DEFAULT_STATE_STORE_TTL,
  type Clock,
  type GuardRejection,
  type PlanApplication,
  type StateStore,
  type StateStoreFactory,
  type StateStoreTtl,
} from '@cold-reserve/core';

// In-memory StateStore. It mirrors the DynamoDB single-table keys (plan §3.2) so both adapters
// behave the same: PK = HOME#<homeId>, SK = PREFS | PLAN#<id> | EVENT#<ts>#<n> | GUARD#<ts>#<n> |
// STORM#<startedAt>#<id> | INBOX#<at>#<n>.
// Expired items are invisible on read, like DynamoDB TTL items that are not yet deleted.

interface Item {
  readonly value: unknown;
  readonly expiresAtMs?: number;
}

/** The shared "table": one per process, reached by every store built on it. */
export interface MemoryBacking {
  readonly partitions: Map<string, Map<string, Item>>;
  sequence: number;
}

export const createMemoryBacking = (): MemoryBacking => ({ partitions: new Map(), sequence: 0 });

export interface MemoryStateStoreOptions {
  readonly backing: MemoryBacking;
  readonly clock: Clock;
  readonly ttl?: StateStoreTtl;
}

const DAY_MS = 24 * 60 * 60_000;
const MAX_CHANGES = 99;

export const memoryStateStoreFactory =
  (options: MemoryStateStoreOptions): StateStoreFactory =>
  (homeId) =>
    new MemoryStateStore(homeId, options);

class MemoryStateStore implements StateStore {
  readonly homeId: HomeId;
  readonly #options: MemoryStateStoreOptions;
  readonly #ttl: StateStoreTtl;

  constructor(homeId: HomeId, options: MemoryStateStoreOptions) {
    this.homeId = homeId;
    this.#options = options;
    this.#ttl = options.ttl ?? DEFAULT_STATE_STORE_TTL;
  }

  getPreferences(): Promise<Result<Preferences | undefined, ErrorEnvelope>> {
    return Promise.resolve(this.#read('PREFS', PreferencesSchema));
  }

  putPreferences(preferences: Preferences, changes: readonly ConfigChange[]): Promise<Result<void, ErrorEnvelope>> {
    // Validate everything first, so the preferences and their log are written together or not at all.
    if (changes.some((change) => !IsoDateTimeSchema.safeParse(change.ts).success)) {
      return Promise.resolve(err(toolError('invalid_input', 'Every configuration change needs an ISO 8601 time.', { details: { field: 'changes' } })));
    }
    // Same limit as store-dynamodb: preferences + changes fit in one 100-item transaction.
    if (changes.length > MAX_CHANGES) {
      return Promise.resolve(err(toolError('invalid_input', `At most ${String(MAX_CHANGES)} changes at once.`, { details: { field: 'changes' } })));
    }
    this.#put('PREFS', { value: preferences });
    for (const change of changes) {
      const sk = `EVENT#${change.ts}#${String(this.#next())}`;
      this.#put(sk, { value: change, expiresAtMs: epochMs(change.ts) + this.#ttl.configChangeDays * DAY_MS });
    }
    return Promise.resolve(ok(undefined));
  }

  listConfigChanges(): Promise<Result<ConfigChange[], ErrorEnvelope>> {
    const changes = this.#query<ConfigChange>('EVENT#').sort((a, b) => epochMs(a.ts) - epochMs(b.ts));
    return Promise.resolve(ok(changes));
  }

  savePlan(plan: Plan): Promise<Result<void, ErrorEnvelope>> {
    const sk = `PLAN#${plan.id}`;
    if (this.#get(sk) !== undefined) {
      return Promise.resolve(err(toolError('invalid_input', `Plan ${plan.id} already exists; a plan id is written once.`, { details: { planId: plan.id } })));
    }
    this.#put(sk, { value: plan, expiresAtMs: epochMs(plan.createdAt) + this.#ttl.planDays * DAY_MS });
    return Promise.resolve(ok(undefined));
  }

  getPlan(planId: PlanId): Promise<Result<Plan, ErrorEnvelope>> {
    const plan = this.#read(`PLAN#${planId}`, PlanSchema);
    if (!plan.ok) return Promise.resolve(plan);
    return Promise.resolve(plan.value ? ok(plan.value) : err(notFound(planId)));
  }

  applyPlan(planId: PlanId): Promise<Result<PlanApplication, ErrorEnvelope>> {
    // Synchronous from read to write: the in-memory equivalent of a conditional update.
    const sk = `PLAN#${planId}`;
    const read = this.#read(sk, PlanSchema);
    if (!read.ok) return Promise.resolve(read);
    const plan = read.value;
    if (!plan) return Promise.resolve(err(notFound(planId)));
    if (plan.status === 'applied') return Promise.resolve(ok({ plan, alreadyApplied: true }));
    if (plan.status !== 'proposed' || this.#options.clock.now() >= epochMs(plan.expiresAt)) {
      return Promise.resolve(err(toolError('plan_expired', 'This plan has expired; ask for a new one.', { details: { planId } })));
    }
    const applied: Plan = { ...plan, status: 'applied' };
    const stored = this.#partition().get(sk);
    this.#put(sk, { value: applied, ...(stored?.expiresAtMs === undefined ? {} : { expiresAtMs: stored.expiresAtMs }) });
    return Promise.resolve(ok({ plan: structuredClone(applied), alreadyApplied: false }));
  }

  recordGuardRejection(rejection: GuardRejection): Promise<Result<void, ErrorEnvelope>> {
    if (rejection.failed.length === 0) {
      return Promise.resolve(err(toolError('invalid_input', 'A guard rejection names at least one failed guarantee.', { details: { field: 'failed' } })));
    }
    if (!IsoDateTimeSchema.safeParse(rejection.at).success) {
      return Promise.resolve(err(toolError('invalid_input', 'A guard rejection needs an ISO 8601 time.', { details: { field: 'at' } })));
    }
    const sk = `GUARD#${rejection.at}#${String(this.#next())}`;
    this.#put(sk, { value: rejection, expiresAtMs: epochMs(rejection.at) + this.#ttl.guardRejectionDays * DAY_MS });
    return Promise.resolve(ok(undefined));
  }

  listGuardRejections(): Promise<Result<GuardRejection[], ErrorEnvelope>> {
    const rejections = this.#query<GuardRejection>('GUARD#').sort((a, b) => epochMs(b.at) - epochMs(a.at));
    return Promise.resolve(ok(rejections));
  }

  saveStormSession(session: StormSession): Promise<Result<void, ErrorEnvelope>> {
    if (session.homeId !== this.homeId) {
      return Promise.resolve(err(toolError('invalid_input', 'A storm session belongs to the home of the store.', { details: { field: 'homeId' } })));
    }
    // Same key as store-dynamodb: the start time in UTC, then the id.
    const sk = `STORM#${new Date(session.startedAt).toISOString()}#${session.id}`;
    this.#put(sk, { value: session, expiresAtMs: epochMs(session.startedAt) + this.#ttl.stormSessionDays * DAY_MS });
    return Promise.resolve(ok(undefined));
  }

  getLatestStormSession(): Promise<Result<StormSession | undefined, ErrorEnvelope>> {
    const sessions = this.#readAll(this.#query<unknown>('STORM#'), StormSessionSchema, 'STORM#');
    if (!sessions.ok) return Promise.resolve(sessions);
    const [latest] = sessions.value.sort((a, b) => epochMs(b.startedAt) - epochMs(a.startedAt));
    return Promise.resolve(ok(latest));
  }

  saveInboxMessage(message: NewInboxMessage): Promise<Result<void, ErrorEnvelope>> {
    const parsed = InboxMessageSchema.safeParse(message);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join('.') ?? 'message';
      return Promise.resolve(err(toolError('invalid_input', 'A family message breaks its contract.', { details: { field } })));
    }
    // Same key as store-dynamodb: the time in UTC, then a sequence, so two messages at once are both kept.
    const sk = `INBOX#${new Date(message.at).toISOString()}#${String(this.#next()).padStart(12, '0')}`;
    this.#put(sk, { value: parsed.data, expiresAtMs: epochMs(message.at) + this.#ttl.inboxDays * DAY_MS });
    return Promise.resolve(ok(undefined));
  }

  listInbox(limit: number): Promise<Result<InboxMessage[], ErrorEnvelope>> {
    const newest = [...this.#partition()]
      .filter(([sk, item]) => sk.startsWith('INBOX#') && this.#live(item))
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .slice(0, Math.max(0, limit))
      .map(([, item]) => structuredClone(item.value));
    return Promise.resolve(this.#readAll(newest, InboxMessageSchema, 'INBOX#'));
  }

  #partition(): Map<string, Item> {
    const pk = `HOME#${this.homeId}`;
    let partition = this.#options.backing.partitions.get(pk);
    if (!partition) {
      partition = new Map();
      this.#options.backing.partitions.set(pk, partition);
    }
    return partition;
  }

  #live(item: Item | undefined): item is Item {
    return item !== undefined && (item.expiresAtMs === undefined || this.#options.clock.now() < item.expiresAtMs);
  }

  /** Reads an item with the same policy as store-dynamodb (R7, #111): unknown fields dropped, the rest checked. */
  #read<T>(sk: string, schema: StoredSchema<T>): Result<T | undefined, ErrorEnvelope> {
    const value = this.#get(sk);
    if (value === undefined) return ok(undefined);
    const parsed = readStored(schema, value);
    return parsed.success ? ok(parsed.data) : err(toolError('unexpected_error', `Stored item ${sk} does not match its schema.`));
  }

  /** The same read policy over several items of one kind. */
  #readAll<T>(values: readonly unknown[], schema: StoredSchema<T>, kind: string): Result<T[], ErrorEnvelope> {
    const read: T[] = [];
    for (const value of values) {
      const parsed = readStored(schema, value);
      if (!parsed.success) return err(toolError('unexpected_error', `A stored ${kind} item does not match its schema.`));
      read.push(parsed.data);
    }
    return ok(read);
  }

  #get(sk: string): unknown {
    const item = this.#partition().get(sk);
    return this.#live(item) ? structuredClone(item.value) : undefined;
  }

  #query<T>(prefix: string): T[] {
    return [...this.#partition()]
      .filter(([sk, item]) => sk.startsWith(prefix) && this.#live(item))
      .map(([, item]) => structuredClone(item.value) as T);
  }

  #put(sk: string, item: Item): void {
    this.#partition().set(sk, { ...item, value: structuredClone(item.value) });
  }

  #next(): number {
    this.#options.backing.sequence += 1;
    return this.#options.backing.sequence;
  }
}

const notFound = (planId: PlanId): ErrorEnvelope => toolError('plan_not_found', `No plan ${planId} for this home.`, { details: { planId } });
