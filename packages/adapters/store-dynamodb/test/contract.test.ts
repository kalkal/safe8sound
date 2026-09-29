import { seededRng } from '@cold-reserve/core';
import { describeStateStoreContract } from '@cold-reserve/core/testing';
import { dynamoStateStoreFactory } from '../src/index.js';
import { createFakeTable } from '../testing/fake-table.js';

// The same contract as store-memory, against an in-process fake of the single table.
// No test ever calls real AWS (cost rule); the suite against the dev table runs later in the
// main pipeline, after deploy.
describeStateStoreContract('store-dynamodb (in-process fake table)', () => {
  let now = 0;
  const table = createFakeTable();
  return {
    factory: dynamoStateStoreFactory({ table, clock: { now: () => now }, rng: seededRng(20) }),
    setNow: (ms) => {
      now = ms;
    },
  };
});
