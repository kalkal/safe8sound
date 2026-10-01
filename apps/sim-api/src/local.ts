import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { httpTurnAgent } from './adapters/agent-http.js';
import { mcpCardTools, streamableMcpCaller } from './adapters/mcp-cards.js';
import { loadSimApiConfig } from './config.js';
import { createSimApiHandler } from './handler.js';
import { nodeListener } from './node-listener.js';
import { memoryQuotaStore } from './quota.js';

// Local sim-api entry (#101): the loopback only, an in-memory quota store, the local agent entry and
// MCP server behind it. The browser only ever gets the demo token; the other tokens stay here.
const log = (line: object) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), component: 'sim-api', ...line }));
};
const fail = (message: string): never => {
  log({ level: 'error', code: 'invalid_config', message });
  process.exit(1);
};

const config = loadSimApiConfig(process.env);
if (!config.ok) fail(config.error.message);
const BackendsSchema = z.strictObject({
  agentUrl: z.url(),
  invokeToken: z.string().min(32),
  agentTimeoutMs: z.coerce.number().int().min(100).max(30_000),
  mcpUrl: z.url(),
  mcpToken: z.string().min(32),
  mcpTimeoutMs: z.coerce.number().int().min(100).max(30_000),
});
const backends = BackendsSchema.safeParse({
  agentUrl: process.env['SIM_AGENT_URL'] ?? 'http://127.0.0.1:3340',
  invokeToken: process.env['AGENT_INVOKE_TOKEN'],
  agentTimeoutMs: process.env['SIM_AGENT_TIMEOUT_MS'] ?? '7500',
  mcpUrl: process.env['SIM_MCP_URL'] ?? 'http://127.0.0.1:3316/mcp',
  mcpToken: process.env['SIM_MCP_TOKEN'],
  mcpTimeoutMs: process.env['SIM_MCP_TIMEOUT_MS'] ?? '3000',
});
if (!backends.success) fail(`Backend settings are not valid: ${backends.error.issues.map((i) => i.path.join('.')).join(', ')}.`);
if (!config.ok || !backends.success) process.exit(1);
const b = backends.data;

const handler = createSimApiHandler(config.value, {
  agent: httpTurnAgent({ url: b.agentUrl, invokeToken: b.invokeToken, timeoutMs: b.agentTimeoutMs, log }),
  tools: mcpCardTools({ caller: streamableMcpCaller({ url: b.mcpUrl, token: b.mcpToken }), timeoutMs: b.mcpTimeoutMs }),
  quota: memoryQuotaStore(),
  clock: { now: Date.now },
  randomHex: () => randomBytes(8).toString('hex'),
  logger: { log },
});

// Client IP from the socket only; body capped while read; a throw becomes a 500 Problem Details.
const server = createServer(nodeListener(handler, { maxBodyBytes: config.value.maxBodyBytes, log }));
server.listen(Number(process.env['PORT'] ?? 3341), '127.0.0.1', () => {
  const { port } = server.address() as AddressInfo;
  console.log(JSON.stringify({ level: 'info', component: 'sim-api', message: `listening on http://127.0.0.1:${String(port)}` }));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
