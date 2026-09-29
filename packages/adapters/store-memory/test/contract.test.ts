import { describeStateStoreContract } from '@cold-reserve/core/testing';
import { createMemoryBacking, memoryStateStoreFactory } from '../src/index.js';

describeStateStoreContract('store-memory', () => {
  let now = 0;
  const backing = createMemoryBacking();
  return {
    factory: memoryStateStoreFactory({ backing, clock: { now: () => now } }),
    setNow: (ms) => {
      now = ms;
    },
  };
});