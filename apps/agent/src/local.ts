import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ErrorEnvelope, Result } from '@cold-reserve/contracts';
import { loadAgentConfig, loadInvokeToken, loadMaxSessions, loadMcpToken } from './config.js';
import { referencePolicy } from './evals/fake-world.js';
import { FakeModel } from './fake-model.js';
import { createHomeAgent } from './home-agent.js';
import { createInvocationHandler } from './invocations.js';
import { connectMcp } from './mcp-tools.js';
import { nodeListener } from './node-listener.js';
import { homeAgents } from './sessions.js';

// Local agent entry (#101): the AgentCore runtime shape on the loopback only, the fake model only
// (cost rule). sim-api invokes it with AGENT_INVOKE_TOKEN; it reaches the MCP server with AGENT_MCP_TOKEN.
const log = (line: object) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), component: 'agent', ...line }));
};

function orExit<T>(result: Result<T, ErrorEnvelope>): T {
  if (result.ok) return result.value;
  log({ level: 'error', code: result.error.code, message: result.error.message });
  process.exit(1);
}

const config = orExit(loadAgentConfig(process.env));
if (config.model.provider !== 'fake') {
  log({ level: 'error', code: 'invalid_config', message: 'Only the fake model is wired until Spike S2.' });
  process.exit(2);
}
const mcpToken = orExit(loadMcpToken(process.env));
const invokeToken = orExit(loadInvokeToken(process.env));
const maxSessions = orExit(loadMaxSessions(process.env));

const agents = homeAgents({
  max: maxSessions,
  create: (home) => createHomeAgent({ config, home, model: new FakeModel(referencePolicy), connect: (h) => connectMcp(config, mcpToken, h), log }),
});
const handle = createInvocationHandler({ invokeToken: invokeToken.reveal(), maxBodyBytes: 8192, agentFor: agents, log });

// The body is capped while it is read (8 KB); a throw becomes a 500 Problem Details (review of #121).
const server = createServer(nodeListener(handle, { maxBodyBytes: 8192, log }));
server.listen(Number(process.env['PORT'] ?? 3340), '127.0.0.1', () => {
  const { port } = server.address() as AddressInfo;
  console.log(JSON.stringify({ level: 'info', component: 'agent', message: `listening on http://127.0.0.1:${String(port)}` }));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
