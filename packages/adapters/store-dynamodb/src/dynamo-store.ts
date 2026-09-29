import {
  ConfigChangeSchema,
  GuaranteeIdSchema,
  IsoDateTimeSchema,
  PlanIdSchema,
  PlanSchema,
  PreferencesSchema,
  epochMs,
  err,
  ok,
  toolError,
  type ConfigChange,
  type ErrorEnvelope,
  type HomeId,
  type Plan,
  type PlanId,
  type Preferences,
  type Result,
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
import { z } from 'zod';
import type { TableClient, TableItem } from './table.js';

// StateStore on the single table (plan §3.2): PK = HOME#<homeId>; SK = PREFS | PLAN#<id> |
// EVENT#<ts>#<n> | GUARD#<ts>#<n>. Every item carries schemaVersion; logs and plans carry the
// DynamoDB TTL attribute `ttl` (epoch seconds). TTL deletion is lazy, so reads skip expired items.

const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60_000;

const GuardRejectionSchema = z.strictObject({
  at: IsoDateTimeSchema,
  failed: z.array(GuaranteeIdSchema).min(1),
  planId: PlanIdSchema.optional(),
});

export interface DynamoStateStoreOptions {
  readonly table: TableClient;
  readonly clock: Clock;
  readonly ttl?: StateStoreTtl;
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
  readonly #ttl: StateStoreTtl;
  readonly #pk: string;
  #sequence = 0;

  constructor(homeId: HomeId, options: DynamoStateStoreOptions) {
    this.homeId = homeId;
    this.#table = options.table;
    this.#clock = options.clock;
    this.#ttl = options.ttl ?? DEFAULT_STATE_STORE_TTL;
    this.#pk = `HOME#${homeId}`;
  }

  getPreferences() {
    return this.#run(async () => {
      const item = await this.#table.get(this.#pk, 'PREFS');
      return item ? parse(PreferencesSchema, item) : undefined;
    });
  }

  putPreferences(preferences: Preferences, changes: readonly ConfigChange[]) {
    return this.#run(async () => {
      await this.#table.put(this.#item('PREFS', preferences));
      for (const change of changes) {
        await this.#table.put(this.#item(`EVENT#${change.ts}#${this.#suffix()}`, change, epochMs(change.ts) + this.#ttl.configChangeDays * DAY_MS));
      }
    });
  }

  listConfigChanges() {
    return this.#run(async () => {
      const changes = (await this.#live('EVENT#')).map((item) => parse(ConfigChangeSchema, item));
      return changes.sort((a, b) => epochMs(a.ts) - epochMs(b.ts));
    });
  }

  savePlan(plan: Plan) {
    return this.#run(async () => {
      const item = { ...this.#item(`PLAN#${plan.id}`, plan, epochMs(plan.createdAt) + this.#ttl.planDays * DAY_MS), status: plan.status, expiresAtMs: epochMs(plan.expiresAt) };
      const outcome = await this.#table.put(item, [{ attr: 'PK', op: 'not_exists' }]);
      if (outcome === 'condition_failed') {
        throw new Failure(toolError('invalid_input', `Plan ${plan.id} already exists; a plan id is written once.`, { details: { planId: plan.id } }));
      }
    });
  }

  getPlan(planId: PlanId) {
    return this.#run(async () => (await this.#readPlan(planId)) ?? fail(notFound(planId)));
  }

  applyPlan(planId: PlanId): Promise<Result<PlanApplication, ErrorEnvelope>> {
    return this.#run(async () => {
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
    return this.#run(async () => {
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
    return this.#run(async () => {
      const rejections = (await this.#live('GUARD#')).map((item): GuardRejection => {
        const { planId, ...rest } = parse(GuardRejectionSchema, item);
        return planId === undefined ? rest : { ...rest, planId };
      });
      return rejections.sort((a, b) => epochMs(b.at) - epochMs(a.at));
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

  /** Unique within this store instance and across instances: time + counter + random. */
  #suffix(): string {
    this.#sequence += 1;
    return `${String(this.#clock.now())}-${String(this.#sequence)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async #run<T>(body: () => Promise<T>): Promise<Result<T, ErrorEnvelope>> {
    try {
      return ok(await body());
    } catch (error) {
      if (error instanceof Failure) return err(error.error);
      // Network, throttling or any other table failure: transient for the caller (degraded mode).
      return err(toolError('store_unavailable', 'The saved settings are not reachable right now; try again shortly.'));
    }
  }
}

function parse<T>(schema: z.ZodType<T>, item: TableItem): T {
  const parsed = schema.safeParse(item['data']);
  if (!parsed.success) {
    throw new Failure(toolError('unexpected_error', `Stored item ${item.SK} does not match its schema.`));
  }
  return parsed.data;
}

function fail(error: ErrorEnvelope): never {
  throw new Failure(error);
}

const notFound = (planId: PlanId) => toolError('plan_not_found', `No plan ${planId} for this home.`, { details: { planId } });
const expired = (planId: PlanId) => toolError('plan_expired', 'This plan has expired; ask for a new one.', { details: { planId } });
