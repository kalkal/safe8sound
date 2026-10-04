import { AdminSettingsSchema, HomeIdSchema, PlanSchema, PreferencesSchema, SandboxSettingsSchema, StormSessionSchema, epochMs } from '@cold-reserve/contracts';
import { examplePlan, examplePreferences } from '@cold-reserve/contracts/fixtures';
import { seededRng, type Rng } from '@cold-reserve/core';
import { describe, expect, it } from 'vitest';
import { dynamoStateStoreFactory, type StoreErrorEvent, type TableClient, type TableItem } from '../src/index.js';
import { createFakeTable } from '../testing/fake-table.js';

const HOME = HomeIdSchema.parse('demo#dynamo0001');
const plan = PlanSchema.parse(examplePlan());
const createdMs = epochMs(plan.createdAt);
const DAY_S = 24 * 60 * 60;
const prefs = () => PreferencesSchema.parse(examplePreferences());
const change = { ts: plan.createdAt, field: 'safety.cooling.maxC', from: 27, to: 28, by: 'user' as const, confirmed: true as const };

function setup(table: TableClient = createFakeTable(), rng: Rng = seededRng(7)) {
  const errors: StoreErrorEvent[] = [];
  const store = dynamoStateStoreFactory({ table, clock: { now: () => createdMs }, rng, onError: (e) => errors.push(e) })(HOME);
  return { table, store, errors };
}

/** An error shaped like the AWS SDK v3 service errors (they carry $metadata). */
const sdkError = (name: string, httpStatusCode = 400, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode }, ...extra });

const failing = (error: Error): TableClient => ({
  get: () => Promise.reject(error),
  put: () => Promise.reject(error),
  update: () => Promise.reject(error),
  query: () => Promise.reject(error),
  transactPut: () => Promise.reject(error),
});

describe('store-dynamodb item layout (plan §3.2)', () => {
  it('writes preferences under HOME#<homeId> / PREFS with a schema version and no TTL', async () => {
    const { table, store } = setup();
    await store.putPreferences(prefs(), []);
    const item = await table.get(`HOME#${HOME}`, 'PREFS');
    expect(item).toMatchObject({ PK: 'HOME#demo#dynamo0001', SK: 'PREFS', schemaVersion: 1 });
    expect(item).not.toHaveProperty('ttl');
  });

  it('sets the DynamoDB TTL attribute (epoch seconds) on plans, config changes and guard rejections', async () => {
    const { table, store } = setup();
    await store.savePlan(plan);
    await store.putPreferences(prefs(), [change]);
    await store.recordGuardRejection({ at: plan.createdAt, failed: ['storm_reserve'] });

    const createdS = createdMs / 1000;
    expect(await table.get(`HOME#${HOME}`, `PLAN#${plan.id}`)).toMatchObject({ ttl: createdS + 30 * DAY_S, status: 'proposed' });
    const [event] = await table.query(`HOME#${HOME}`, 'EVENT#');
    expect(event).toMatchObject({ ttl: createdS + 90 * DAY_S });
    const [guard] = await table.query(`HOME#${HOME}`, 'GUARD#');
    expect(guard).toMatchObject({ ttl: createdS + 90 * DAY_S });
  });

  it('counts the TTL from the write on the wall clock, and keeps expiresAtMs in domain time (#175)', async () => {
    const table = createFakeTable();
    const wallMs = createdMs + 400 * DAY_S * 1000;
    const store = dynamoStateStoreFactory({ table, clock: { now: () => wallMs }, rng: seededRng(7) })(HOME);
    await store.savePlan(plan);
    await store.saveLastResortConfirmation({ planId: plan.id, tokenHash: 'a'.repeat(64), planHash: 'c'.repeat(64), expiresAt: plan.expiresAt }, createdMs);

    const wallS = wallMs / 1000;
    // The plan's lifetime also runs on the wall clock from the write: a replayed scenario day never revives it.
    const lifetimeMs = epochMs(plan.expiresAt) - createdMs;
    expect(await table.get(`HOME#${HOME}`, `PLAN#${plan.id}`)).toMatchObject({ ttl: wallS + 30 * DAY_S, expiresAtMs: epochMs(plan.expiresAt), wallDeadlineMs: wallMs + lifetimeMs });
    expect(await table.get(`HOME#${HOME}`, `CONFIRM#${plan.id}`)).toMatchObject({ ttl: wallS + 30 * DAY_S, expiresAtMs: epochMs(plan.expiresAt), wallDeadlineMs: wallMs + lifetimeMs, used: 0 });
  });

  it('builds log sort keys from the injected clock and Rng, never Math.random()', async () => {
    const { table, store } = setup(createFakeTable(), { next: () => 0.5 });
    await store.recordGuardRejection({ at: plan.createdAt, failed: ['storm_reserve'] });
    const [guard] = await table.query(`HOME#${HOME}`, 'GUARD#');
    expect(guard?.SK).toBe(`GUARD#${plan.createdAt}#${String(createdMs)}-1-${Math.floor(0.5 * 36 ** 6).toString(36)}`);
  });

  it('keys storm sessions by start time then id, so the newest is read with one query (plan §3.2)', async () => {
    const { table, store } = setup();
    const session = StormSessionSchema.parse({
      schemaVersion: 1, id: 'storm_layout0001', homeId: HOME, phase: 'prepare', trigger: 'user',
      startedAt: '2026-07-17T15:00:00+02:00', safeRoomId: 'bedroom-1', occupantRoles: [], hoursAtEssential: 10, notifications: [],
    });
    await store.saveStormSession(session);
    const [item] = await table.query(`HOME#${HOME}`, 'STORM#');
    expect(item?.SK).toBe('STORM#2026-07-17T13:00:00.000Z#storm_layout0001');
  });
});

describe('store-dynamodb writes preferences and their log atomically', () => {
  it('sends PREFS and every EVENT# item in one transaction', async () => {
    const fake = createFakeTable();
    const transactions: TableItem[][] = [];
    const spy: TableClient = { ...fake, transactPut: (items) => (transactions.push([...items]), fake.transactPut(items)) };
    const { store } = setup(spy);
    await store.putPreferences(prefs(), [change, { ...change, field: 'language', from: 'en-US', to: 'it-IT' }]);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.map((i) => i.SK.split('#')[0])).toEqual(['EVENT', 'EVENT', 'PREFS']);
  });

  it('leaves nothing half-written when the transaction fails', async () => {
    const fake = createFakeTable();
    const { store } = setup({ ...fake, transactPut: () => Promise.reject(sdkError('TransactionCanceledException', 400, { CancellationReasons: [{ Code: 'TransactionConflict' }] })) });
    expect(await store.putPreferences(prefs(), [change])).toMatchObject({ ok: false, error: { code: 'store_unavailable' } });
    expect(await fake.get(`HOME#${HOME}`, 'PREFS')).toBeUndefined();
    expect(await fake.query(`HOME#${HOME}`, 'EVENT#')).toEqual([]);
  });
});

describe('store-dynamodb failures (docs/error-handling.md)', () => {
  it('turns an SDK or network failure into store_unavailable (retryable) and reports the cause', async () => {
    const cause = sdkError('ThrottlingException');
    const { store, errors } = setup(failing(cause));
    for (const result of [await store.getPreferences(), await store.getPlan(plan.id), await store.savePlan(plan), await store.listGuardRejections()]) {
      expect(result).toMatchObject({ ok: false, error: { code: 'store_unavailable', retryable: true } });
    }
    expect(errors[0]).toMatchObject({ code: 'store_unavailable', operation: 'getPreferences', cause });
  });

  it('turns a table failure into store_unavailable for the settings too, never a conflict or a miss (review of #216)', async () => {
    const cause = sdkError('ThrottlingException');
    const { store, errors } = setup(failing(cause));
    const sandbox = SandboxSettingsSchema.parse({ version: 1, updatedAt: '2026-10-04T08:00:00Z', scenarioId: 'heatwave', locationId: 'turin', units: 'C', household: 'older-woman' });
    const admin = AdminSettingsSchema.parse({
      version: 1,
      updatedAt: '2026-10-04T08:00:00Z',
      demoEnabled: true,
      caps: { turnsPerCodePerDay: 20, turnsGlobalPerDay: 30, toolCallsPerCodePerDay: 20, codeAttemptsPerIpPerHour: 10, sandboxesPerDay: 50, speechCharsPerCodePerDay: 6000, speechCharsGlobalPerDay: 30_000 },
      sandboxDefaults: sandbox,
    });
    const results = [await store.getSandboxSettings(), await store.putSandboxSettings(sandbox, undefined), await store.getAdminConfig(), await store.putAdminConfig(admin, undefined)];
    for (const result of results) expect(result).toMatchObject({ ok: false, error: { code: 'store_unavailable', retryable: true } });
    expect(errors.map((e) => e.operation)).toEqual(['getSandboxSettings', 'putSandboxSettings', 'getAdminConfig', 'putAdminConfig']);
  });

  it('reports the correlation id of the request the store serves, so the failure is found with its request (#111)', async () => {
    const cause = sdkError('ThrottlingException');
    const errors: StoreErrorEvent[] = [];
    const factory = dynamoStateStoreFactory({ table: failing(cause), clock: { now: () => createdMs }, rng: seededRng(7), onError: (e) => errors.push(e) });
    await factory(HOME, { correlationId: 'corr-42' }).getPreferences();
    await factory(HOME).getPreferences();
    expect(errors.map((e) => e.correlationId)).toEqual(['corr-42', undefined]);
  });

  it.each([
    ['a 400 ValidationException', sdkError('ValidationException')],
    ['AccessDeniedException', sdkError('AccessDeniedException')],
    ['ResourceNotFoundException (wrong table name)', sdkError('ResourceNotFoundException')],
    ['a validation-type TransactionCanceledException', sdkError('TransactionCanceledException', 400, { CancellationReasons: [{ Code: 'ValidationError' }] })],
  ])('reports %s as unexpected_error, not retryable', async (_name, cause) => {
    const { store } = setup(failing(cause));
    expect(await store.getPreferences()).toMatchObject({ ok: false, error: { code: 'unexpected_error', retryable: false } });
  });

  it.each([
    ['a 5xx server error', sdkError('InternalFailure', 503)],
    ['a 429', sdkError('SomethingNew', 429)],
    ['an error the SDK marks retryable', sdkError('UnknownError', 400, { $retryable: {} })],
    ['a server fault', sdkError('UnknownError', 400, { $fault: 'server' })],
    ['a conflicting transaction', sdkError('TransactionCanceledException', 400, { CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }] })],
  ])('reports %s as store_unavailable (retryable)', async (_name, cause) => {
    const { store } = setup(failing(cause));
    expect(await store.getPreferences()).toMatchObject({ ok: false, error: { code: 'store_unavailable', retryable: true } });
  });

  it('treats a network error without SDK metadata as transient too', async () => {
    const { store } = setup(failing(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })));
    expect(await store.getPreferences()).toMatchObject({ ok: false, error: { code: 'store_unavailable' } });
  });

  it('reports a bug (for example a TypeError) as unexpected_error, not as retryable, and keeps the cause', async () => {
    const cause = new TypeError("Cannot read properties of undefined (reading 'Item')");
    const { store, errors } = setup(failing(cause));
    expect(await store.getPreferences()).toMatchObject({ ok: false, error: { code: 'unexpected_error', retryable: false } });
    expect(errors).toEqual([{ code: 'unexpected_error', operation: 'getPreferences', cause }]);
  });

  it('reports an item that no longer matches its schema as unexpected_error', async () => {
    const table = createFakeTable();
    await table.put({ PK: `HOME#${HOME}`, SK: 'PREFS', schemaVersion: 1, data: { language: 'klingon' } });
    const { store } = setup(table);
    expect(await store.getPreferences()).toMatchObject({ ok: false, error: { code: 'unexpected_error', category: 'internal' } });
  });

  it('reads an item a newer version wrote with an additive field: the unknown field is dropped (R7, #111)', async () => {
    const table = createFakeTable();
    await table.put({ PK: `HOME#${HOME}`, SK: 'PREFS', schemaVersion: 1, data: { ...prefs(), addedLater: { theme: 'dark' } } });
    await table.put({ PK: `HOME#${HOME}`, SK: `PLAN#${plan.id}`, schemaVersion: 1, data: { ...plan, futureHint: 'x' } });
    const { store } = setup(table);
    expect(await store.getPreferences()).toEqual({ ok: true, value: prefs() });
    const read = await store.getPlan(plan.id);
    expect(read.ok && read.value).toEqual(plan);
  });

  it('refuses to read an item written with a newer schema version', async () => {
    const table = createFakeTable();
    await table.put({ PK: `HOME#${HOME}`, SK: 'PREFS', schemaVersion: 2, data: prefs() });
    const { store } = setup(table);
    const result = await store.getPreferences();
    expect(result).toMatchObject({ ok: false, error: { code: 'unexpected_error' } });
    expect(!result.ok && result.error.message).toMatch(/schemaVersion 2/);
  });
});
