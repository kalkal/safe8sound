import { defineConfig } from 'vitest/config';

// One Vitest run for the whole workspace. Locally at most 2 workers (old 4-core PC), 1 when memory is short;
// run a single module with `pnpm test packages/<name>`.
export default defineConfig({
  test: {
    include: ['{packages,apps,infra,tooling}/**/test/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/cdk.out/**', 'tooling/test/fixtures/**'],
    // `pnpm heavy` sets VITEST_MAX_WORKERS from the free memory (2 or 1); CI has 4 cores.
    maxWorkers: Number(process.env['VITEST_MAX_WORKERS'] ?? (process.env['CI'] ? 4 : 2)),
    testTimeout: 20_000,
    // `vitest --changed` (pnpm check:changed) runs every test when one of these changes: files the tests read from
    // disk, not import (config, prompts, skill text, styles, data), so the import graph alone would miss them.
    forceRerunTriggers: [
      '**/package.json/**',
      '**/vitest.config.*/**',
      '**/vite.config.*/**',
      '**/infra/cdk.json',
      '**/infra/cloudfront/**',
      '**/skills/**',
      '**/apps/agent/prompts/**',
      '**/apps/agent/evals/**',
      '**/apps/alexa-skill/skill-package/**',
      '**/apps/*/config/**',
      '**/apps/alexa-sim/*.json',
      '**/packages/ui-cards/src/**/*.css',
      '**/packages/design-tokens/**',
      '**/packages/adapters/source-simulator/data/**',
      '**/packages/adapters/source-simulator/scenarios/**',
      '**/packages/adapters/source-simulator/locations/**',
      '**/docs/results/**',
    ],
  },
});
