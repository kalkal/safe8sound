import { defineConfig } from '@playwright/test';

// E2E: the demo script (`e2e/demo-script`, one scene per feature) and fault injection (`e2e/faults`).
// ScriptedAgent only: no network, no LLM (cost rule). Locally 1 worker and the installed Chrome;
// CI uses Playwright's Chromium (`pnpm exec playwright install chromium`).
const BASE_URL = 'http://127.0.0.1:5318';
const CI = process.env['CI'] !== undefined;

export default defineConfig({
  testDir: 'e2e',
  // The built site has its own run with its own servers: pnpm e2e:site (playwright.site.config.ts).
  testIgnore: 'site/**',
  // `pnpm heavy` sets E2E_WORKERS from the free memory: 2 with more than 6 GB free, else 1 (O7, 18 Oct).
  workers: Number(process.env['E2E_WORKERS'] ?? 1),
  retries: CI ? 1 : 0,
  timeout: 20_000,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    // A supported size (e2e/support/sizes.json: a 13-15 inch laptop) where Ana's phone stands beside the Echo (#432,
    // PHONE_BESIDE): a spec that sets no size reads the phone as the story shows it. Narrower sizes open the phone
    // through e2e/surface.ts (openPhone).
    viewport: { width: 1440, height: 900 },
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
