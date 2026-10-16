import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { HomeIdSchema, StormSessionSchema } from '@cold-reserve/contracts';
import { seededRng } from '@cold-reserve/core';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentTableClient, documentSender, dynamoCounter, dynamoStateStoreFactory, type DocumentSender, type TableClient } from '../src/index.js';

// What the shared contract suite does not reach, against a REAL DynamoDB table (#68): the atomic quota
// counters with their TTL, the storm claim race repeated until DynamoDB shows both of its answers, and
// the consistent reads. Opt-in only, like real-table.contract.test.ts: set STATE_STORE_CONTRACT_REAL_TABLE.
const tableName = process.env.STATE_STORE_CONTRACT_REAL_TABLE;
const region = process.env.AWS_REGION ?? 'us-east-1';

vi.setConfig({ testTimeout: 60_000 });

const unique = () => Math.random().toString(36).slice(2, 12);

describe.skipIf(tableName === undefined || tableName === '')(`real DynamoDB table ${tableName ?? '(not set)'}`, () => {
  const name = tableName ?? '';
  const raw = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const real = documentSender(raw);
  const sent: Array<{ command: string; input: Record<string, unknown> }> = [];
  const sender: DocumentSender = {
    send: (command) => {
      sent.push({ command: command.constructor.name, input: command.input });
      return real.send(command);
    },
  };

  describe('atomic quota counters with TTL', () => {
    const counter = dynamoCounter({ tableName: name, sender });
    const expiresAtMs = Date.now() + 60 * 60_000;

    it('lets exactly `limit` of many parallel consumes win, and keeps the TTL of the first one', async () => {
      const key = `CT#${unique()}`;
      const results = await Promise.all(Array.from({ length: 12 }, () => counter.consume(key, 5, expiresAtMs)));
      expect(results.filter(Boolean)).toHaveLength(5);
      const item = (await raw.send(new GetCommand({ TableName: name, Key: { PK: `DEMO#${key}`, SK: 'COUNT' }, ConsistentRead: true }))).Item;
      expect(item).toMatchObject({ count: 5, ttl: Math.ceil(expiresAtMs / 1000) });
      // A later consume with another window does not move the TTL (if_not_exists).
      expect(await counter.consume(key, 6, expiresAtMs + 3_600_000)).toBe(true);
      const again = (await raw.send(new GetCommand({ TableName: name, Key: { PK: `DEMO#${key}`, SK: 'COUNT' }, ConsistentRead: true }))).Item;
      expect(again).toMatchObject({ count: 6, ttl: Math.ceil(expiresAtMs / 1000) });
    });

    it('counts amounts, refuses the one that does not fit, and releases without going below zero', async () => {
      const key = `CT#${unique()}`;
      expect(await counter.consume(key, 10, expiresAtMs, 7)).toBe(true);
      expect(await counter.consume(key, 10, expiresAtMs, 4)).toBe(false);
      expect(await counter.consume(key, 10, expiresAtMs, 3)).toBe(true);
      expect(await counter.consume(key, 10, expiresAtMs)).toBe(false);
      await counter.release(key, 4);
      expect(await counter.consume(key, 10, expiresAtMs, 4)).toBe(true);
      await counter.release(key, 10);
      await counter.release(key, 1); // nothing to give back: no error, no negative count
      const item = (await raw.send(new GetCommand({ TableName: name, Key: { PK: `DEMO#${key}`, SK: 'COUNT' }, ConsistentRead: true }))).Item;
      expect(item?.['count']).toBe(0);
      await counter.release(`CT#${unique()}`); // no item at all: no new item, no error
    });
  });

  describe('storm claim race (#389) repeated', () => {
    it('always has exactly one winner out of two parallel claims; reports what DynamoDB answered', async () => {
      const answers: string[] = [];
      const base = createDocumentTableClient({ tableName: name, sender });
      const table: TableClient = {
        ...base,
        transactPut: async (items, conditions) => {
          const outcome = await base.transactPut(items, conditions);
          answers.push(outcome);
          return outcome;
        },
      };
      const factory = dynamoStateStoreFactory({ table, clock: { now: () => Date.now() }, rng: seededRng(389) });
      const rounds = 25;
      for (let i = 0; i < rounds; i += 1) {
        const home = HomeIdSchema.parse(`demo#ct${unique()}`);
        const key = `storm_started#${new Date().toISOString()}#${i}`;
        const session = (id: string) => StormSessionSchema.parse({ ...exampleSession(home), id });
        const both = await Promise.all([factory(home).claimStormSession(session(`storm_${unique()}`), key), factory(home).claimStormSession(session(`storm_${unique()}`), key)]);
        expect(both.every((r) => r.ok)).toBe(true);
        expect(both.filter((r) => r.ok && r.value)).toHaveLength(1);
      }
      console.log(`claim race answers over ${rounds} rounds:`, JSON.stringify(answers.reduce<Record<string, number>>((n, a) => ({ ...n, [a]: (n[a] ?? 0) + 1 }), {})));
    });
  });

  describe('consistent reads', () => {
    it('sends ConsistentRead on every get and query, and reads its own write at once, 20 times', async () => {
      sent.length = 0;
      const table = createDocumentTableClient({ tableName: name, sender });
      const pk = `CT#${unique()}`;
      for (let i = 0; i < 20; i += 1) {
        const sk = `ITEM#${String(i).padStart(3, '0')}`;
        expect(await table.put({ PK: pk, SK: sk, n: i, ttl: Math.ceil(Date.now() / 1000) + 3600 })).toBe('ok');
        expect(await table.get(pk, sk)).toMatchObject({ n: i });
        expect(await table.query(pk, 'ITEM#', { newestFirst: true, limit: 1 })).toMatchObject([{ n: i }]);
      }
      const reads = sent.filter((s) => s.command === 'GetCommand' || s.command === 'QueryCommand');
      expect(reads).toHaveLength(40);
      expect(reads.every((s) => s.input['ConsistentRead'] === true)).toBe(true);
    });
  });
});

function exampleSession(home: string) {
  return {
    schemaVersion: 1,
    id: 'storm_placeholder',
    homeId: home,
    phase: 'prepare',
    trigger: 'user',
    startedAt: new Date().toISOString(),
    safeRoomId: 'bedroom-1',
    occupantRoles: ['grandpa'],
    hoursAtEssential: 18,
    notifications: [],
  };
}
