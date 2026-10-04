import { defineConfig } from '@playwright/test';
import { AWS_SITE_URL, PORTS, SCRIPTED_SITE_URL, SIM_API_URL, chainEnv, originSecret } from './e2e/site/chain.js';

// The site E2E (K1, #242/#244): the BUILT simulator, as CloudFront serves it, in its own run (`pnpm e2e:site`), so the
// demo-script suite keeps one dev server. Two builds:
// - scripted, under the CSP it has on AWS (no backend: e2e/site/csp.spec.ts);
// - AWS mode (remote agent at /api), behind a stand-in for CloudFront that runs the real CloudFront Function, in front
//   of the real local chain: MCP server, agent (fake model), sim-api with no allowed origin (e2e/site/turn.spec.ts).
// Local servers only: no network, no LLM. Commands run node directly, never through pnpm (see playwright.config.ts).
const CI = process.env['CI'] !== undefined;
const env = chainEnv();
const vite = 'node node_modules/vite/bin/vite.js';
const headers = 'node node_modules/tsx/dist/cli.mjs scripts/site-headers.ts';
const local = 'node --import tsx src/local.ts';

export default defineConfig({
  testDir: 'e2e/site',
  workers: 1,
  retries: CI ? 1 : 0,
  timeout: 30_000,
  reporter: 'list',
  use: { trace: 'retain-on-failure', ...(CI ? {} : { channel: 'chrome' }) },
  webServer: [
    {
      command: [`${vite} build --outDir dist-e2e --emptyOutDir`, `${headers} dist-e2e`, `${vite} preview --outDir dist-e2e --host 127.0.0.1 --port ${String(PORTS.scriptedSite)} --strictPort`].join(' && '),
      cwd: 'apps/alexa-sim',
      url: SCRIPTED_SITE_URL,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { VITE_AGENT: 'scripted', SITE_E2E_OUT_DIR: 'dist-e2e' },
    },
    { command: local, cwd: 'apps/mcp-server', port: PORTS.mcp, reuseExistingServer: false, timeout: 120_000, env: env.mcp },
    { command: local, cwd: 'apps/agent', port: PORTS.agent, reuseExistingServer: false, timeout: 120_000, env: env.agent },
    { command: local, cwd: 'apps/sim-api', port: PORTS.simApi, reuseExistingServer: false, timeout: 120_000, env: env.simApi },
    {
      command: [
        `${vite} build --mode aws --outDir dist-e2e-aws --emptyOutDir`,
        `${headers} dist-e2e-aws`,
        `${vite} preview --outDir dist-e2e-aws --host 127.0.0.1 --port ${String(PORTS.awsSite)} --strictPort`,
      ].join(' && '),
      cwd: 'apps/alexa-sim',
      url: AWS_SITE_URL,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { SITE_E2E_OUT_DIR: 'dist-e2e-aws', SITE_E2E_SIM_API: SIM_API_URL, SITE_E2E_ORIGIN_SECRET: originSecret() },
    },
  ],
});
