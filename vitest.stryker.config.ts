import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Vitest for mutation testing (tooling/src/mutation.mjs): property tests with fewer cases.
// Workspace packages are aliased to the sources next to this file: in Stryker's sandbox the pnpm links
// still point at the original checkout, so `@cold-reserve/core` would load the unmutated code.
const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@cold-reserve\/core$/, replacement: src('core') },
      { find: /^@cold-reserve\/guard$/, replacement: src('guard') },
    ],
  },
  test: {
    include: ['packages/{core,guard}/test/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    env: { FC_RUNS: '50' },
    testTimeout: 60_000,
  },
});
