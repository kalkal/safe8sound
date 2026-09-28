import { defineConfig } from 'vitest/config';

// One Vitest run for the whole workspace. Locally at most 2 workers (old 4-core PC);
// run a single module with `pnpm test packages/<name>`.
export default defineConfig({
  test: {
    include: ['{packages,apps,infra,tooling}/**/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/cdk.out/**', 'tooling/test/fixtures/**'],
    maxWorkers: process.env['CI'] ? 4 : 2,
    testTimeout: 20_000,
  },
});
