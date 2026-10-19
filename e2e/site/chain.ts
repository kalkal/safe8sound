import { createHash, randomBytes } from 'node:crypto';

// The site E2E (K1, #244): the AWS build of the simulator behind a stand-in for CloudFront, in front of the real local
// chain (MCP server, agent with the fake model, sim-api configured as on AWS: no allowed origin). Fixed ports, apart
// from the dev defaults; tokens fresh for each run. ScriptedAgent nowhere on this path; no network, no LLM.

/**
 * SITE_E2E_PORT_OFFSET moves every port at once: the chain that e2e/site/with-chain.ts keeps up between heavy slices
 * never meets another session's `pnpm e2e:site` on the same ports.
 */
const OFFSET = Number(process.env['SITE_E2E_PORT_OFFSET'] ?? 0);
export const PORTS = { scriptedSite: 5319 + OFFSET, awsSite: 5320 + OFFSET, mcp: 3416 + OFFSET, agent: 3440 + OFFSET, simApi: 3441 + OFFSET } as const;
export const SCRIPTED_SITE_URL = `http://127.0.0.1:${String(PORTS.scriptedSite)}`;
export const AWS_SITE_URL = `http://127.0.0.1:${String(PORTS.awsSite)}`;
export const SIM_API_URL = `http://127.0.0.1:${String(PORTS.simApi)}`;

/** The demo code the visitor types; only its sha256 reaches sim-api's settings. */
export const DEMO_CODE = process.env['SITE_E2E_DEMO_CODE'] ?? randomBytes(12).toString('hex');
process.env['SITE_E2E_DEMO_CODE'] = DEMO_CODE;

/** One value per run, kept in the environment so the config and the tests (other processes) agree on it. */
const secret = (name: string, make = () => randomBytes(24).toString('hex')) => {
  const value = process.env[name] ?? make();
  process.env[name] = value;
  return value;
};

/** The origin secret the CloudFront stand-in adds, as the distribution does from SSM. */
export const originSecret = () => secret('SITE_E2E_ORIGIN_SECRET');

export function chainEnv() {
  const agentMcp = secret('SITE_E2E_AGENT_MCP');
  const simMcp = secret('SITE_E2E_SIM_MCP');
  const invoke = secret('SITE_E2E_INVOKE');
  // As deployed (#267): sim-api reads the visitor sandbox's family inbox with its own phone token.
  const phone = secret('SITE_E2E_PHONE');
  const mcpUrl = `http://127.0.0.1:${String(PORTS.mcp)}/mcp`;
  return {
    // As deployed (infra/cdk.json): the daily anchor at real speed; a fresh sandbox stores its own start at its first request
    // (#449: a new sandbox, scenario, place or restart plays the day from its own hour, the clear day from 12:00).
    mcp: {
      PORT: String(PORTS.mcp),
      MCP_CLIENTS: `agent:agent@demo#*=${agentMcp},cards:simapi@demo#*=${simMcp},phone:daughter@demo#*=${phone}`,
      MCP_SCENARIO: 'clear-day',
      MCP_SCENARIO_ANCHOR: 'daily',
    },
    agent: { PORT: String(PORTS.agent), AGENT_MCP_URL: mcpUrl, AGENT_MCP_TOKEN: agentMcp, AGENT_INVOKE_TOKEN: invoke },
    simApi: {
      PORT: String(PORTS.simApi),
      SIM_DEMO_CODES: `judges:${createHash('sha256').update(DEMO_CODE).digest('hex')}`,
      SIM_TOKEN_KEYS: `k1:${secret('SITE_E2E_TOKEN_KEY', () => randomBytes(32).toString('base64url'))}`,
      // As on AWS: the site calls sim-api same-origin through CloudFront, so no origin is allowed directly.
      SIM_ALLOWED_ORIGINS: '',
      SIM_AGENT_URL: `http://127.0.0.1:${String(PORTS.agent)}`,
      AGENT_INVOKE_TOKEN: invoke,
      SIM_MCP_URL: mcpUrl,
      SIM_MCP_TOKEN: simMcp,
      SIM_PHONE_TOKEN: phone,
      // One demo code for a whole run: both journeys at every size share one chain (e2e/site/with-chain.ts), past the per-code quotas.
      SIM_LIMIT_TURNS_PER_CODE: '2000',
      SIM_LIMIT_TURNS_GLOBAL: '2000',
      SIM_LIMIT_TOOL_CALLS_PER_CODE: '5000',
      // sim-api's own maxima (apps/sim-api/src/config.ts): 10,000 per code a day.
      SIM_LIMIT_READ_CALLS_PER_CODE: '10000',
      SIM_LIMIT_READ_CALLS_GLOBAL: '50000',
      SIM_LIMIT_DEMO_CALLS_PER_CODE: '10000',
      // As on AWS (#243): sim-api serves only what came through the distribution, which adds this secret.
      SIM_ORIGIN_SECRET: originSecret(), // gitleaks:allow (random per test run)
    },
  };
}
