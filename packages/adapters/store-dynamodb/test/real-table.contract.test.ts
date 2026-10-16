import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { seededRng } from '@cold-reserve/core';
import { describeStateStoreContract } from '@cold-reserve/core/testing';
import { describe, vi } from 'vitest';
import { createDocumentTableClient, documentSender, dynamoStateStoreFactory } from '../src/index.js';

// The shared StateStore contract suite against a REAL DynamoDB table (#68).
// Opt-in only: set STATE_STORE_CONTRACT_REAL_TABLE=<table name> (and AWS credentials, region from
// AWS_REGION, default us-east-1). Without the variable the suite is skipped, so CI and the normal
// test runs never reach AWS (cost rule). Use a dedicated, temporary table with the same shape as the
// state table (PK/SK strings, TTL `ttl`), never a table other things use.
// The backend is treated as SHARED by default (sharedBackend: true), so the admin config test, which would
// overwrite ADMIN#CONFIG, is skipped. It runs only on a temporary table whose name contains `contract-test`,
// or when STATE_STORE_CONTRACT_DEDICATED_TABLE=1 says explicitly that nothing else uses the table.
const tableName = process.env.STATE_STORE_CONTRACT_REAL_TABLE;
const dedicated = (tableName ?? '').includes('contract-test') || process.env.STATE_STORE_CONTRACT_DEDICATED_TABLE === '1';
const region = process.env.AWS_REGION ?? 'us-east-1';

vi.setConfig({ testTimeout: 30_000 });

if (tableName === undefined || tableName === '') {
  describe.skip('store-dynamodb (real table, opt-in via STATE_STORE_CONTRACT_REAL_TABLE)', () => undefined);
} else {
  describeStateStoreContract(`store-dynamodb (real table ${tableName})`, () => {
    let now = Date.now();
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
    const table = createDocumentTableClient({ tableName, sender: documentSender(client) });
    return {
      factory: dynamoStateStoreFactory({
        table,
        clock: { now: () => now },
        rng: seededRng(68),
        onError: (event) => {
          console.error('store error', event.code, event.operation, event.cause);
        },
      }),
      setNow: (ms) => {
        now = ms;
      },
      sharedBackend: !dedicated,
      startMs: Math.floor(Date.now() / 1000) * 1000,
    };
  });
}
