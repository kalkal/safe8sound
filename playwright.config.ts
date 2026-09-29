import { defineConfig } from '@playwright/test';

// E2E: the demo script (`e2e/demo-script`, one scene per feature) and fault injection (`e2e/faults`).
// ScriptedAgent only: no network, no LLM (cost rule). Locally 1 worker and the installed Chrome;
// CI uses Playwright's Chromium (`pnpm exec playwright install chromium`).
const BASE_URL = 'http://127.0.0.1:5318';
const CI = process.env['CI'] !== undefined;

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  retries: CI ? 1 : 0,
  timeout: 20_000,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    ...(CI ? {} : { channel: 'chrome' }),
  },
  webServer: {
    // Vite directly, not through pnpm: in CI a pnpm-wrapped server outlived the run and hung the job.
    command: 'node node_modules/vite/bin/vite.js',
    cwd: 'apps/alexa-sim',
    url: BASE_URL,
    reuseExistingServer: !CI,
    timeout: 120_000,
    env: { VITE_AGENT: 'scripted' },
  },
});
