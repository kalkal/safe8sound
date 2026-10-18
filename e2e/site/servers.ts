import { AWS_SITE_URL, PORTS, SCRIPTED_SITE_URL, SIM_API_URL, chainEnv, originSecret } from './chain.js';

// The servers of the site E2E, in one place: the two builds of the simulator, each served as CloudFront would, and
// the real local chain behind the AWS one (MCP server, agent with the fake model, sim-api). The site config starts
// them for one run; e2e/site/with-chain.ts builds and starts them once for every screen size of the journeys (O4).
// Commands run node directly, never through pnpm (see playwright.config.ts).

const vite = 'node node_modules/vite/bin/vite.js';
const headers = 'node node_modules/tsx/dist/cli.mjs scripts/site-headers.ts';
const local = 'node --import tsx src/local.ts';

export interface SiteServer {
  readonly name: string;
  /** The build before it serves (the two sites), run once. */
  readonly build?: string;
  readonly serve: string;
  /** Relative to the repo root. */
  readonly cwd: string;
  /** Ready when this URL answers, or when this port takes connections. */
  readonly url?: string;
  readonly port?: number;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
}

export function siteServers(): readonly SiteServer[] {
  const env = chainEnv();
  return [
    {
      name: 'scripted site',
      build: [`${vite} build --outDir dist-e2e --emptyOutDir`, `${headers} dist-e2e`].join(' && '),
      serve: `${vite} preview --outDir dist-e2e --host 127.0.0.1 --port ${String(PORTS.scriptedSite)} --strictPort`,
      cwd: 'apps/alexa-sim',
      url: SCRIPTED_SITE_URL,
      timeoutMs: 180_000,
      env: { VITE_AGENT: 'scripted', SITE_E2E_OUT_DIR: 'dist-e2e' },
    },
    { name: 'MCP server', serve: local, cwd: 'apps/mcp-server', port: PORTS.mcp, timeoutMs: 120_000, env: env.mcp },
    { name: 'agent', serve: local, cwd: 'apps/agent', port: PORTS.agent, timeoutMs: 120_000, env: env.agent },
    { name: 'sim-api', serve: local, cwd: 'apps/sim-api', port: PORTS.simApi, timeoutMs: 120_000, env: env.simApi },
    {
      name: 'AWS site',
      build: [`${vite} build --mode aws --outDir dist-e2e-aws --emptyOutDir`, `${headers} dist-e2e-aws`].join(' && '),
      serve: `${vite} preview --outDir dist-e2e-aws --host 127.0.0.1 --port ${String(PORTS.awsSite)} --strictPort`,
      cwd: 'apps/alexa-sim',
      url: AWS_SITE_URL,
      timeoutMs: 180_000,
      env: { SITE_E2E_OUT_DIR: 'dist-e2e-aws', SITE_E2E_SIM_API: SIM_API_URL, SITE_E2E_ORIGIN_SECRET: originSecret() },
    },
  ];
}

/** Set by e2e/site/with-chain.ts: the servers are already up, every Playwright run reuses them. */
export const CHAIN_UP = process.env['SITE_CHAIN_UP'] === '1';
