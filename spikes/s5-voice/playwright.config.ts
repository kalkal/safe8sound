import { defineConfig } from '@playwright/test';

// Locally we reuse the installed Google Chrome (no browser download on the old PC);
// CI would use Playwright's Chromium (`pnpm exec playwright install chromium`).
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 20_000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5175',
    ...(process.env.CI ? {} : { channel: 'chrome' }),
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
