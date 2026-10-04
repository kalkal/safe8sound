import {
  AdminSettingsSchema,
  InboxMessageSchema,
  SandboxSettingsSchema,
  IsoDateTimeSchema,
  PlanSchema,
  PreferencesSchema,
  StormSessionSchema,
  readStored,
  epochMs,
  err,
  ok,
  toolError,
  type AdminSettings,
  type ConfigChange,
  type ErrorEnvelope,
  type HomeId,
  type InboxMessage,
  type NewInboxMessage,
  type Plan,
  type PlanId,
  type Preferences,
  type Result,
  type SandboxSettings,
  type StormSession,
  type StoredSchema,
} from '@cold-reserve/contracts';
import {
  DEFAULT_STATE_STORE_TTL,
  type Clock,
  invalidLastResortToken,
  lastResortConfirmationProblem,
  type GuardRejection,
  type LastResortConfirmation,
  type PlanApplication,
  type StateStore,
  type StateStoreFactory,
  type StateStoreTtl,
} from '@cold-reserve/core';

// In-memory StateStore. It mirrors the DynamoDB single-table keys (plan §3.2) so both adapters
// behave the same: PK = HOME#<homeId>, SK = PREFS | PLAN#<id> | EVENT#<ts>#<n> | GUARD#<ts>#<n> |
// STORM#<startedAt>#<id> | INBOX#<at>#<n> | CONFIRM#<planId>.
// Expired items are invisible on read, like DynamoDB TTL items that are not yet deleted.

interface Item {
  readonly value: unknown;
  readonly expiresAtMs?: number;
  /** Plans and confirmations: the wall instant their lifetime runs out, whatever scenario time says (#175 review). */
  readonly wallDeadlineMs?: number;
}

/** The shared "table": one per process, reached by every store built on it. */
export interface MemoryBacking {
  readonly partitions: Map<string, Map<string, Item>>;
  sequence: number;
}

export const createMemoryBacking = (): MemoryBacking => ({ partitions: new Map(), sequence: 0 });

export interface MemoryStateStoreOptions {
  readonly backing: MemoryBacking;
  /** The wall clock: it drives only the retention. Domain expiry is judged on the `now` each call passes (#175). */
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
      this.#put(sk, { value: change, expiresAtMs: this.#retainedFor(this.#ttl.configChangeDays) });
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
    const wallDeadlineMs = this.#options.clock.now() + (epochMs(plan.expiresAt) - epochMs(plan.createdAt));
    this.#put(sk, { value: plan, expiresAtMs: this.#retainedFor(this.#ttl.planDays), wallDeadlineMs });
    return Promise.resolve(ok(undefined));
  }

  getPlan(planId: PlanId): Promise<Result<Plan, ErrorEnvelope>> {
    const plan = this.#read(`PLAN#${planId}`, PlanSchema);
    if (!plan.ok) return Promise.resolve(plan);
    return Promise.resolve(plan.value ? ok(plan.value) : err(notFound(planId)));
  }

  applyPlan(planId: PlanId, now: number): Promise<Result<PlanApplication, ErrorEnvelope>> {
    // Synchronous from read to write: the in-memory equivalent of a conditional update.
    const sk = `PLAN#${planId}`;
    const read = this.#read(sk, PlanSchema);
    if (!read.ok) return Promise.resolve(read);
    const plan = read.value;
    if (!plan) return Promise.resolve(err(notFound(planId)));
    if (plan.status === 'applied') return Promise.resolve(ok({ plan, alreadyApplied: true }));
    const stored = this.#partition().get(sk);
    if (plan.status !== 'proposed' || now >= epochMs(plan.expiresAt) || !this.#beforeWallDeadline(stored)) {
      return Promise.resolve(err(toolError('plan_expired', 'This plan has expired; ask for a new one.', { details: { planId } })));
    }
    const applied: Plan = { ...plan, status: 'applied' };
    this.#put(sk, { ...stored, value: applied });
    return Promise.resolve(ok({ plan: structuredClone(applied), alreadyApplied: false }));
  }

  saveLastResortConfirmation(confirmation: LastResortConfirmation, now: number): Promise<Result<void, ErrorEnvelope>> {
    const problem = lastResortConfirmationProblem(confirmation);
    if (problem !== undefined) return Promise.resolve(err(problem));
    // One per plan, like store-dynamodb: a new confirmation replaces the earlier one.
    const wallDeadlineMs = this.#options.clock.now() + (epochMs(confirmation.expiresAt) - now);
    this.#put(`CONFIRM#${confirmation.planId}`, { value: { confirmation, used: false }, expiresAtMs: this.#retainedFor(this.#ttl.planDays), wallDeadlineMs });
    return Promise.resolve(ok(undefined));
  }

  consumeLastResortConfirmation(planId: PlanId, tokenHash: string, now: number): Promise<Result<LastResortConfirmation, ErrorEnvelope>> {
    // Synchronous from read to write: the in-memory equivalent of a conditional update.
    const sk = `CONFIRM#${planId}`;
    const item = this.#partition().get(sk);
    if (!this.#live(item)) return Promise.resolve(err(invalidLastResortToken()));
    const stored = item.value as { confirmation: LastResortConfirmation; used: boolean };
    if (stored.used || stored.confirmation.tokenHash !== tokenHash || now >= epochMs(stored.confirmation.expiresAt) || !this.#beforeWallDeadline(item)) {
      return Promise.resolve(err(invalidLastResortToken()));
    }
    this.#put(sk, { ...item, value: { ...stored, used: true } });
    return Promise.resolve(ok(structuredClone(stored.confirmation)));
  }

  recordGuardRejection(rejection: GuardRejection): Promise<Result<void, ErrorEnvelope>> {
    if (rejection.failed.length === 0) {
      return Promise.resolve(err(toolError('invalid_input', 'A guard rejection names at least one failed guarantee.', { details: { field: 'failed' } })));
    }
    if (!IsoDateTimeSchema.safeParse(rejection.at).success) {
      return Promise.resolve(err(toolError('invalid_input', 'A guard rejection needs an ISO 8601 time.', { details: { field: 'at' } })));
    }
    const sk = `GUARD#${rejection.at}#${String(this.#next())}`;
    this.#put(sk, { value: rejection, expiresAtMs: this.#retainedFor(this.#ttl.guardRejectionDays) });
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
    this.#put(sk, { value: session, expiresAtMs: this.#retainedFor(this.#ttl.stormSessionDays) });
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
    this.#put(sk, { value: parsed.data, expiresAtMs: this.#retainedFor(this.#ttl.inboxDays) });
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

  getSandboxSettings(): Promise<Result<SandboxSettings, ErrorEnvelope>> {
    return Promise.resolve(this.#readSettings(this.#partition(), 'SETTINGS', SandboxSettingsSchema));
  }

  putSandboxSettings(settings: SandboxSettings, expectedVersion: number | undefined): Promise<Result<void, ErrorEnvelope>> {
    return Promise.resolve(this.#writeSettings(this.#partition(), 'SETTINGS', SandboxSettingsSchema, settings, expectedVersion));
  }

  getAdminConfig(): Promise<Result<AdminSettings, ErrorEnvelope>> {
    return Promise.resolve(this.#readSettings(this.#adminPartition(), 'CONFIG', AdminSettingsSchema));
  }

  putAdminConfig(config: AdminSettings, expectedVersion: number | undefined): Promise<Result<void, ErrorEnvelope>> {
    return Promise.resolve(this.#writeSettings(this.#adminPartition(), 'CONFIG', AdminSettingsSchema, config, expectedVersion));
  }

  /** The admin config is one for every home (C1): its own partition, ADMIN#CONFIG. */
  #adminPartition(): Map<string, Item> {
    let partition = this.#options.backing.partitions.get('ADMIN#CONFIG');
    if (!partition) {
      partition = new Map();
      this.#options.backing.partitions.set('ADMIN#CONFIG', partition);
    }
    return partition;
  }

  #readSettings<T>(partition: Map<string, Item>, sk: string, schema: StoredSchema<T>): Result<T, ErrorEnvelope> {
    const item = partition.get(sk);
    if (item === undefined) return err(toolError('settings_not_found', 'No settings are stored yet.'));
    const parsed = readStored(schema, item.value);
    return parsed.success ? ok(parsed.data) : err(toolError('unexpected_error', `Stored item ${sk} does not match its schema.`));
  }

  /** The same conditional write as store-dynamodb: only against the version read, and only the next version. */
  #writeSettings<T extends { version: number }>(partition: Map<string, Item>, sk: string, schema: StoredSchema<T>, value: T, expectedVersion: number | undefined): Result<void, ErrorEnvelope> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return err(toolError('invalid_input', 'The settings do not match their schema.'));
    if (value.version !== (expectedVersion ?? 0) + 1) return err(toolError('invalid_input', 'The settings must carry the version after the one read.', { details: { field: 'version' } }));
    const stored = partition.get(sk)?.value as { version?: unknown } | undefined;
    const current = typeof stored?.version === 'number' ? stored.version : undefined;
    if (current !== expectedVersion) return err(toolError('settings_version_conflict', 'The settings changed since they were read: read them again.'));
    partition.set(sk, { value: structuredClone(value) });
    return ok(undefined);
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

  /** An item without a deadline (written before it existed) has none to miss; plans and confirmations always get one. */
  #beforeWallDeadline(item: Item | undefined): boolean {
    return item?.wallDeadlineMs === undefined || this.#options.clock.now() < item.wallDeadlineMs;
  }

  /** Retention from the write on the wall clock, never from the item's domain times (#175). */
  #retainedFor(days: number): number {
    return this.#options.clock.now() + days * DAY_MS;
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
