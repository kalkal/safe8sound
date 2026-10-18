import { defineConfig } from '@playwright/test';
import { CHAIN_UP, siteServers } from './e2e/site/servers.js';
import { SIZES, projectOf } from './e2e/support/sizes.js';

// The site E2E (K1, #242/#244): the BUILT simulator, as CloudFront serves it, in its own run (`pnpm e2e:site`), so the
// demo-script suite keeps one dev server. Two builds:
// - scripted, under the CSP it has on AWS (no backend: e2e/site/csp.spec.ts);
// - AWS mode (remote agent at /api), behind a stand-in for CloudFront that runs the real CloudFront Function, in front
//   of the real local chain: MCP server, agent (fake model), sim-api with no allowed origin (e2e/site/turn.spec.ts).
// Local servers only: no network, no LLM. Commands run node directly, never through pnpm (see playwright.config.ts).
const CI = process.env['CI'] !== undefined;

export default defineConfig({
  testDir: 'e2e/site',
  workers: 1,
  retries: CI ? 1 : 0,
  timeout: 30_000,
  reporter: 'list',
  // No trace against a deployed site: a trace keeps the typed demo code and the session token (e2e/support/target.ts).
  use: { trace: process.env['JOURNEY_BASE_URL'] === undefined ? 'retain-on-failure' : 'off', ...(CI ? {} : { channel: 'chrome' }) },
  projects: [
    { name: 'site', testIgnore: 'journeys/**' },
    // The journeys (e2e/site/journeys, docs/outcomes.md): one project per screen size, each a whole visit in one page,
    // so never retried; a failing step leaves its screenshot in e2e-results/journeys/<size>/.
    ...SIZES.map((size) => ({
      name: projectOf(size),
      testMatch: 'journeys/**/*.journey.spec.ts',
      retries: 0,
      // A step may wait for two reads of Ana's inbox before and after an answer (e2e/support/phone.ts).
      timeout: 90_000,
      outputDir: `e2e-results/journeys/${size.id}`,
      use: { viewport: { width: size.width, height: size.height }, screenshot: 'only-on-failure' as const },
    })),
  ],
  // A deployed site (JOURNEY_BASE_URL, journeys only: e2e/support/target.ts) needs no local server. Started once by
  // e2e/site/with-chain.ts (SITE_CHAIN_UP=1), the servers are reused by every run instead of built again (O4).
  webServer:
    process.env['JOURNEY_BASE_URL'] !== undefined
      ? []
      : siteServers().map((server) => ({
          command: server.build === undefined ? server.serve : `${server.build} && ${server.serve}`,
          cwd: server.cwd,
          ...(server.url !== undefined ? { url: server.url } : server.port !== undefined ? { port: server.port } : {}),
          reuseExistingServer: CHAIN_UP,
          timeout: server.timeoutMs,
          env: { ...server.env },
        })),
});
