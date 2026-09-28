import { defineConfig } from '@playwright/test';

// Uses the installed Chrome (no browser download). One worker: old PC.
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'chrome',
    viewport: { width: 900, height: 1100 },
  },
  webServer: [
    { command: 'pnpm server', port: 3100, reuseExistingServer: false, timeout: 60_000 },
    { command: 'pnpm host', url: 'http://127.0.0.1:5173', reuseExistingServer: false, timeout: 60_000 },
  ],
});
