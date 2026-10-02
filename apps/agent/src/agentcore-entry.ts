import type { AddressInfo } from 'node:net';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { jsonLineSink, loggerTo } from '@cold-reserve/core';
import { cachedOnSuccess, sdkReader } from '@cold-reserve/ssm-parameters';
import { buildAgentCoreServer } from './agentcore.js';
import { logLine, type AgentLogEntry } from './log.js';
import { readMcpToken } from './ssm-token.js';

// The process AgentCore starts (G1a): bundled to one CommonJS app.js by scripts/bundle.ts. Every line is
// the shared LogEntry of L1, one JSON line on stdout (#143). A broken config stops the process before it
// listens, with the reason in the log.
const logger = loggerTo(
  jsonLineSink((text) => {
    process.stdout.write(text);
  }),
);
const log = (entry: AgentLogEntry) => {
  logger.log(entry);
};

// On AgentCore the MCP token is an SSM SecureString, read when the first invocation needs it (decided in
// #17); locally (and in the bundle test) it can still come from AGENT_MCP_TOKEN.
const parameter = process.env['AGENT_MCP_TOKEN_PARAMETER'];
const mcpToken =
  parameter === undefined || parameter === ''
    ? undefined
    : (() => {
        const client = new SSMClient({});
        const read = sdkReader({ getParameter: (input, options) => client.send(new GetParameterCommand(input), options), timeoutMs: process.env['AGENT_SSM_TIMEOUT_MS'] });
        return cachedOnSuccess(() => readMcpToken(read, parameter));
      })();

const built = buildAgentCoreServer(process.env, { log, ...(mcpToken === undefined ? {} : { mcpToken }) });
if (!built.ok) {
  // Our own startup reason (which setting is wrong), never a value: it goes under details.
  log({ ...logLine(built.error, 'StartupConfig'), details: { reason: built.error.message } });
  process.exit(1);
} else {
  const server = built.value;
  server.listen(Number(process.env['PORT'] ?? 8080), process.env['HOST'] ?? '0.0.0.0', () => {
    log({ ts: new Date().toISOString(), level: 'info', component: 'agent', message: 'listening', correlationId: 'none', details: { port: (server.address() as AddressInfo).port } });
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}
