import {
  AdminSettingsSchema,
  ConfigChangeSchema,
  GuaranteeIdSchema,
  InboxMessageSchema,
  IsoDateTimeSchema,
  isReadableSchemaVersion,
  readStored,
  PlanIdSchema,
  PlanSchema,
  PreferencesSchema,
  SandboxSettingsSchema,
  StormSessionSchema,
  epochMs,
  err,
  ok,
  toolError,
  type AdminSettings,
  type ConfigChange,
  type ErrorEnvelope,
  type HomeId,
  type NewInboxMessage,
  type Plan,
  type PlanId,
  type Preferences,
  type Result,
  type SandboxSettings,
  type StormSession,
} from '@cold-reserve/contracts';
import {
  DEFAULT_STATE_STORE_TTL,
  invalidLastResortToken,
  lastResortConfirmationProblem,
  type Clock,
  type GuardRejection,
  type LastResortConfirmation,
  type Rng,
  type PlanApplication,
  type StateStore,
  type StateStoreFactory,
  type StoreScope,
  type StateStoreTtl,
} from '@cold-reserve/core';
import { z } from 'zod';
import type { TableClient, TableItem } from './table.js';

// StateStore on the single table (plan §3.2): PK = HOME#<homeId>; SK = PREFS | PLAN#<id> |
// EVENT#<ts>#<n> | GUARD#<ts>#<n> | CONFIRM#<planId> | [PLAY#<playthrough>#]STORM#… | [PLAY#<playthrough>#]INBOX#… | SETTINGS (a sandbox's settings, C1,
// with a top-level `version` for the conditional write). One item outside the homes: PK = ADMIN#CONFIG,
// SK = CONFIG, the demo's admin config read by every home (C1, same conditional write). The sim-api's quota
// counters live under DEMO#… (counter.ts). Every item carries schemaVersion; logs and plans carry the DynamoDB TTL
// attribute `ttl` (epoch seconds, from the write on the wall clock, #175); settings never expire. TTL deletion is lazy, so reads skip expired items.

const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60_000;
/** DynamoDB TransactWriteItems limit. */
const MAX_TRANSACTION_ITEMS = 100;

const GuardRejectionSchema = z.strictObject({
  at: IsoDateTimeSchema,
  failed: z.array(GuaranteeIdSchema).min(1),
  planId: PlanIdSchema.optional(),
});

const ConfirmationSchema = z.strictObject({
  planId: PlanIdSchema,
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: IsoDateTimeSchema,
});

export interface DynamoStateStoreOptions {
  readonly table: TableClient;
  /** The wall clock: it drives only the retention (TTL). Domain expiry is judged on the `now` each call passes (#175). */
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
  /** The request the store was serving, when the caller said (#111). */
  readonly correlationId?: string;
}

export const dynamoStateStoreFactory =
  (options: DynamoStateStoreOptions): StateStoreFactory =>
  (homeId, scope) =>
    new DynamoStateStore(homeId, options, scope);

/** The partition of the admin config, shared by every home (C1). */
const ADMIN_PK = 'ADMIN#CONFIG';

/** An expected outcome carried out of a #run body; converted back to a Result there. */
class Failure extends Error {
  /** `logAs`: an unexpected outcome also reported to onError under this error name (#114: the cause goes to the log, never the message). */
  constructor(
    readonly error: ErrorEnvelope,
    readonly logAs?: string,
  ) {
    super(error.message);
  }
}

class DynamoStateStore implements StateStore {
  readonly homeId: HomeId;
  readonly #table: TableClient;
  readonly #clock: Clock;
  readonly #rng: Rng;
  readonly #onError: ((event: StoreErrorEvent) => void) | undefined;
  readonly #correlationId: string | undefined;
  readonly #ttl: StateStoreTtl;
  readonly #pk: string;
  /** Where this playthrough's storm sessions and family messages live (#234); '' without one. */
  readonly #play: string;
  #sequence = 0;

  constructor(homeId: HomeId, options: DynamoStateStoreOptions, scope?: StoreScope) {
    this.homeId = homeId;
    this.#table = options.table;
    this.#clock = options.clock;
    this.#rng = options.rng;
    this.#onError = options.onError;
    this.#correlationId = scope?.correlationId;
    this.#play = scope?.playthrough === undefined ? '' : `PLAY#${String(scope.playthrough)}#`;
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
        this.#item(`EVENT#${change.ts}#${this.#suffix()}`, change, this.#retainedFor(this.#ttl.configChangeDays)),
      );
      await this.#table.transactPut([...events, this.#item('PREFS', preferences)]);
    });
  }

  listConfigChanges() {
    return this.#run('listConfigChanges', async () => {
      // In the order they were written: a replayed day's scenario times are no order (#234).
      return inWriteOrder(await this.#live('EVENT#')).map((item) => parse(ConfigChangeSchema, item));
    });
  }

  savePlan(plan: Plan) {
    return this.#run('savePlan', async () => {
      // `expiresAtMs` is domain time; `wallDeadlineMs` the same lifetime on the wall clock, which never rewinds (#175 review).
      const wallDeadlineMs = this.#clock.now() + (epochMs(plan.expiresAt) - epochMs(plan.createdAt));
      const item = { ...this.#item(`PLAN#${plan.id}`, plan, this.#retainedFor(this.#ttl.planDays)), status: plan.status, expiresAtMs: epochMs(plan.expiresAt), wallDeadlineMs };
      const outcome = await this.#table.put(item, [{ attr: 'PK', op: 'not_exists' }]);
      if (outcome === 'condition_failed') {
        throw new Failure(toolError('invalid_input', `Plan ${plan.id} already exists; a plan id is written once.`, { details: { planId: plan.id } }));
      }
    });
  }

  getSandboxSettings() {
    return this.#run('getSandboxSettings', async () => this.#readSettings(this.#pk, 'SETTINGS', SandboxSettingsSchema));
  }

  putSandboxSettings(settings: SandboxSettings, expectedVersion: number | undefined) {
    return this.#run('putSandboxSettings', async () => this.#writeSettings(this.#pk, 'SETTINGS', SandboxSettingsSchema, settings, expectedVersion));
  }

  /** The admin config is one for every home (C1, approved in #214): its own item, ADMIN#CONFIG. */
  getAdminConfig() {
    return this.#run('getAdminConfig', async () => this.#readSettings(ADMIN_PK, 'CONFIG', AdminSettingsSchema));
  }

  putAdminConfig(config: AdminSettings, expectedVersion: number | undefined) {
    return this.#run('putAdminConfig', async () => this.#writeSettings(ADMIN_PK, 'CONFIG', AdminSettingsSchema, config, expectedVersion));
  }

  async #readSettings<T>(pk: string, sk: string, schema: z.ZodType<T>): Promise<T> {
    const item = await this.#table.get(pk, sk);
    return item ? parse(schema, item) : fail(toolError('settings_not_found', 'No settings are stored yet.'));
  }

  /** One conditional put: only against the version read (none stored yet when undefined), and only the next version. */
  async #writeSettings<T extends { version: number }>(pk: string, sk: string, schema: z.ZodType<T>, value: T, expectedVersion: number | undefined): Promise<void> {
    if (!schema.safeParse(value).success) fail(toolError('invalid_input', 'The settings do not match their schema.'));
    if (value.version !== (expectedVersion ?? 0) + 1) fail(toolError('invalid_input', 'The settings must carry the version after the one read.', { details: { field: 'version' } }));
    const item: TableItem = { PK: pk, SK: sk, schemaVersion: SCHEMA_VERSION, data: value, version: value.version };
    const outcome = await this.#table.put(item, expectedVersion === undefined ? [{ attr: 'PK', op: 'not_exists' }] : [{ attr: 'version', op: '=', value: expectedVersion }]);
    if (outcome === 'condition_failed') fail(toolError('settings_version_conflict', 'The settings changed since they were read: read them again.'));
  }

  getPlan(planId: PlanId) {
    return this.#run('getPlan', async () => (await this.#readPlan(planId)) ?? fail(notFound(planId)));
  }

  applyPlan(planId: PlanId, now: number): Promise<Result<PlanApplication, ErrorEnvelope>> {
    return this.#run('applyPlan', async () => {
      const plan = (await this.#readPlan(planId)) ?? fail(notFound(planId));
      if (plan.status === 'applied') return { plan, alreadyApplied: true };
      if (plan.status !== 'proposed' || now >= epochMs(plan.expiresAt)) return fail(expired(planId));

      const applied: Plan = { ...plan, status: 'applied' };
      const outcome = await this.#table.update(this.#pk, `PLAN#${planId}`, { status: 'applied', data: applied }, [
        { attr: 'status', op: '=', value: 'proposed' },
        { attr: 'expiresAtMs', op: '>', value: now },
        { attr: 'wallDeadlineMs', op: '>', value: this.#clock.now() },
      ]);
      if (outcome === 'ok') return { plan: applied, alreadyApplied: false };
      // Lost the race or the plan changed meanwhile: report what is stored now.
      const current = (await this.#readPlan(planId)) ?? fail(notFound(planId));
      return current.status === 'applied' ? { plan: current, alreadyApplied: true } : fail(expired(planId));
    });
  }

  saveLastResortConfirmation(confirmation: LastResortConfirmation, now: number) {
    return this.#run('saveLastResortConfirmation', async () => {
      const problem = lastResortConfirmationProblem(confirmation);
      if (problem !== undefined) fail(problem);
      // One per plan, kept as long as a plan: a new confirmation replaces the earlier one. The conditions of the use
      // read these top-level attributes; `expiresAtMs` is domain time, the TTL is the wall clock's (#175).
      const item = this.#item(`CONFIRM#${confirmation.planId}`, confirmation, this.#retainedFor(this.#ttl.planDays));
      const wallDeadlineMs = this.#clock.now() + (epochMs(confirmation.expiresAt) - now);
      await this.#table.put({ ...item, tokenHash: confirmation.tokenHash, used: 0, expiresAtMs: epochMs(confirmation.expiresAt), wallDeadlineMs });
    });
  }

  consumeLastResortConfirmation(planId: PlanId, tokenHash: string, now: number) {
    return this.#run('consumeLastResortConfirmation', async () => {
      const sk = `CONFIRM#${planId}`;
      const item = await this.#table.get(this.#pk, sk);
      if (item === undefined || !this.#isLive(item)) return fail(invalidLastResortToken());
      const confirmation = parse(ConfirmationSchema, item);
      // Once, before it expires, with this token: the conditional write decides between concurrent uses.
      const outcome = await this.#table.update(this.#pk, sk, { used: 1 }, [
        { attr: 'tokenHash', op: '=', value: tokenHash },
        { attr: 'used', op: '=', value: 0 },
        { attr: 'expiresAtMs', op: '>', value: now },
        { attr: 'wallDeadlineMs', op: '>', value: this.#clock.now() },
      ]);
      return outcome === 'ok' ? confirmation : fail(invalidLastResortToken());
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
      await this.#table.put(this.#item(`GUARD#${rejection.at}#${this.#suffix()}`, rejection, this.#retainedFor(this.#ttl.guardRejectionDays)));
    });
  }

  listGuardRejections() {
    return this.#run('listGuardRejections', async () => {
      return inWriteOrder(await this.#live('GUARD#'))
        .reverse()
        .map((item): GuardRejection => {
          const { planId, ...rest } = parse(GuardRejectionSchema, item);
          return planId === undefined ? rest : { ...rest, planId };
        });
    });
  }

  saveStormSession(session: StormSession) {
    return this.#run('saveStormSession', async () => {
      if (session.homeId !== this.homeId) {
        fail(toolError('invalid_input', 'A storm session belongs to the home of the store.', { details: { field: 'homeId' } }));
      }
      await this.#table.put(this.#item(`${this.#play}${stormKey(session)}`, session, this.#retainedFor(this.#ttl.stormSessionDays)));
    });
  }

  claimStormAlert(key: string) {
    return this.#run('claimStormAlert', async () => {
      if (key.length === 0) fail(toolError('invalid_input', 'A storm alert claim needs a key.', { details: { field: 'key' } }));
      // SK = ALERT#<key>, one conditional put: of two containers at once, only one writes it.
      const outcome = await this.#table.put(this.#item(`${this.#play}ALERT#${key}`, { key }, this.#retainedFor(this.#ttl.stormSessionDays)), [{ attr: 'PK', op: 'not_exists' }]);
      return outcome === 'ok';
    });
  }

  getLatestStormSession() {
    return this.#run('getLatestStormSession', async () => {
      // SK = STORM#<startedAt in UTC>#<id>: the newest session is the highest key, one item read.
      // Retention counts from the write and sessions are written in the order they start: if it has expired, every older one has too.
      const [latest] = await this.#table.query(this.#pk, `${this.#play}STORM#`, { newestFirst: true, limit: 1 });
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
      const sk = `${this.#play}INBOX#${new Date(message.at).toISOString()}#${this.#suffix()}`;
      await this.#table.put(this.#item(sk, message, this.#retainedFor(this.#ttl.inboxDays)));
    });
  }

  listInbox(limit: number) {
    return this.#run('listInbox', async () => {
      if (limit <= 0) return [];
      // Messages are written in time order and kept from the write, so the live ones are a prefix of the newest-first page.
      const newest = await this.#table.query(this.#pk, `${this.#play}INBOX#`, { newestFirst: true, limit });
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

  /** Retention from the write on the wall clock, never from the item's domain times (#175). */
  #retainedFor(days: number): number {
    return this.#clock.now() + days * DAY_MS;
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
      if (error instanceof Failure) {
        if (error.logAs !== undefined) {
          const cause = Object.assign(new Error(error.error.message), { name: error.logAs });
          this.#onError?.({ code: 'unexpected_error', operation, cause, ...(this.#correlationId === undefined ? {} : { correlationId: this.#correlationId }) });
        }
        return err(error.error);
      }
      // Only the table and the network fail transiently; anything else is a bug and must not be retried.
      const code = isTransient(error) ? 'store_unavailable' : 'unexpected_error';
      this.#onError?.({ code, operation, cause: error, ...(this.#correlationId === undefined ? {} : { correlationId: this.#correlationId }) });
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

/** Reads a stored item (R7, #111): any version up to the current one; fields a newer version added are dropped. */
function parse<T>(schema: z.ZodType<T>, item: TableItem): T {
  if (!isReadableSchemaVersion(item['schemaVersion'], SCHEMA_VERSION)) {
    throw new Failure(
      toolError('unexpected_error', `A stored record has schemaVersion ${String(item['schemaVersion'])}; this version reads ${String(SCHEMA_VERSION)}.`),
      'StoredItemNewerSchema',
    );
  }
  const parsed = readStored(schema, item['data']);
  if (!parsed.success) {
    throw new Failure(toolError('unexpected_error', 'A stored record does not match its schema.'), 'StoredItemInvalid');
  }
  return parsed.data;
}

/** Sort key of a storm session (plan §3.2): the start time in UTC orders the sessions, the id keeps it unique. */
/** Log items, oldest write first: their keys end with `<wall ms>-<sequence>-<random>` (#suffix). */
function inWriteOrder(items: readonly TableItem[]): TableItem[] {
  const order = (item: TableItem) => {
    const sk = item['SK'];
    const [ms = 0, seq = 0] = sk.slice(sk.lastIndexOf('#') + 1).split('-').map(Number);
    return [ms, seq] as const;
  };
  return [...items].sort((a, b) => {
    const [am, as] = order(a);
    const [bm, bs] = order(b);
    return am - bm || as - bs;
  });
}

const stormKey = (session: StormSession) => `STORM#${new Date(session.startedAt).toISOString()}#${session.id}`;

function fail(error: ErrorEnvelope): never {
  throw new Failure(error);
}

const notFound = (planId: PlanId) => toolError('plan_not_found', `No plan ${planId} for this home.`, { details: { planId } });
const expired = (planId: PlanId) => toolError('plan_expired', 'This plan has expired; ask for a new one.', { details: { planId } });
