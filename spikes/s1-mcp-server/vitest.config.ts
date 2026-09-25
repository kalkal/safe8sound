import { defineConfig } from 'vitest/config';

// Old 4-core machine: never more than 2 workers. Threads instead of forks: fewer
// process starts (node.exe intermittently crashes at startup with 0xC0000005 here).
export default defineConfig({
  test: {
    pool: 'threads',
    maxWorkers: 2,
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
