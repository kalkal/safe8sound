import { HomeIdSchema, PlanSchema, PreferencesSchema, epochMs } from '@cold-reserve/contracts';
import { examplePlan, examplePreferences } from '@cold-reserve/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import { dynamoStateStoreFactory, type TableClient } from '../src/index.js';
import { createFakeTable } from '../testing/fake-table.js';

const HOME = HomeIdSchema.parse('demo#dynamo0001');
const plan = PlanSchema.parse(examplePlan());
const createdMs = epochMs(plan.createdAt);
const DAY_S = 24 * 60 * 60;

function setup(table: TableClient = createFakeTable()) {
  const store = dynamoStateStoreFactory({ table, clock: { now: () => createdMs } })(HOME);
  return { table, store };
}

describe('store-dynamodb item layout (plan §3.2)', () => {
  it('writes preferences under HOME#<homeId> / PREFS with a schema version and no TTL', async () => {
    const { table, store } = setup();
    await store.putPreferences(PreferencesSchema.parse(examplePreferences()), []);
    const item = await table.get(`HOME#${HOME}`, 'PREFS');
    expect(item).toMatchObject({ PK: 'HOME#demo#dynamo0001', SK: 'PREFS', schemaVersion: 1 });
    expect(item).not.toHaveProperty('ttl');
  });

  it('sets the DynamoDB TTL attribute (epoch seconds) on plans, config changes and guard rejections', async () => {
    const { table, store } = setup();
    await store.savePlan(plan);
    await store.putPreferences(PreferencesSchema.parse(examplePreferences()), [
      { ts: plan.createdAt, field: 'safety.cooling.maxC', from: 27, to: 28, by: 'user', confirmed: true },
    ]);
    await store.recordGuardRejection({ at: plan.createdAt, failed: ['storm_reserve'] });

    const createdS = createdMs / 1000;
    expect(await table.get(`HOME#${HOME}`, `PLAN#${plan.id}`)).toMatchObject({ ttl: createdS + 30 * DAY_S, status: 'proposed' });
    const [event] = await table.query(`HOME#${HOME}`, 'EVENT#');
    expect(event).toMatchObject({ ttl: createdS + 90 * DAY_S });
    const [guard] = await table.query(`HOME#${HOME}`, 'GUARD#');
    expect(guard).toMatchObject({ ttl: createdS + 90 * DAY_S });
  });
});

describe('store-dynamodb failures (docs/error-handling.md)', () => {
  const broken: TableClient = {
    get: () => Promise.reject(new Error('ThrottlingException')),
    put: () => Promise.reject(new Error('ThrottlingException')),
    update: () => Promise.reject(new Error('ThrottlingException')),
    query: () => Promise.reject(new Error('ThrottlingException')),
  };

  it('turns a table failure into store_unavailable (retryable), never a thrown error', async () => {
    const { store } = setup(broken);
    for (const result of [await store.getPreferences(), await store.getPlan(plan.id), await store.savePlan(plan), await store.listGuardRejections()]) {
      expect(result).toMatchObject({ ok: false, error: { code: 'store_unavailable', retryable: true } });
    }
  });

  it('reports an item that no longer matches its schema as unexpected_error', async () => {
    const table = createFakeTable();
    await table.put({ PK: `HOME#${HOME}`, SK: 'PREFS', schemaVersion: 1, data: { language: 'klingon' } });
    const { store } = setup(table);
    expect(await store.getPreferences()).toMatchObject({ ok: false, error: { code: 'unexpected_error', category: 'internal' } });
  });
});
