import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { PROBLEM_JSON_CONTENT_TYPE, ok, toProblemDetails, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { loadAgentConfig, loadMaxSessions, loadMcpToken, type McpToken } from './config.js';
import { referencePolicy } from './evals/fake-world.js';
import { FakeModel } from './fake-model.js';
import { createHomeAgent } from './home-agent.js';
import { createInvocationHandler } from './invocations.js';
import { logLine, type AgentLogEntry } from './log.js';
import { connectMcp } from './mcp-tools.js';
import { createModel } from './model.js';
import { nodeListener } from './node-listener.js';
import { homeAgents } from './sessions.js';

/**
 * The AgentCore runtime entry (G1a): GET /ping and POST /invocations, the model from config (Bedrock Nova
 * 2 Lite on AgentCore, the fake one elsewhere). No bearer: the runtime is reached only through
 * InvokeAgentRuntime, which IAM (SigV4) authenticates (decided in #17). Nothing listens until the config
 * is valid; the caller starts the server on the port the platform gives (8080).
 *
 * The MCP token comes from AGENT_MCP_TOKEN, or from `mcpToken` (the SSM SecureString on AgentCore), read
 * when the first invocation needs it: if SSM does not answer, that invocation is a 503 config_unavailable,
 * /ping stays healthy, and the next invocation tries again (decided in #17).
 */
export function buildAgentCoreServer(
  env: Readonly<Record<string, string | undefined>>,
  deps: { readonly log: (entry: AgentLogEntry) => void; readonly mcpToken?: () => Promise<Result<McpToken, ErrorEnvelope>> },
): Result<Server, ErrorEnvelope> {
  const config = loadAgentConfig(env);
  if (!config.ok) return config;
  const maxSessions = loadMaxSessions(env);
  if (!maxSessions.ok) return maxSessions;
  let token: McpToken | undefined;
  if (deps.mcpToken === undefined) {
    const fromEnv = loadMcpToken(env);
    if (!fromEnv.ok) return fromEnv;
    token = fromEnv.value;
  }
  const readToken = deps.mcpToken;

  const agents = homeAgents({
    max: maxSessions.value,
    create: (home) =>
      createHomeAgent({
        config: config.value,
        home,
        model: createModel(config.value, () => new FakeModel(referencePolicy)),
        // Agents are created only after the token is known (see below).
        connect: (h) => (token === undefined ? Promise.reject(new Error('MCP token not loaded')) : connectMcp(config.value, token, h)),
        log: deps.log,
      }),
  });
  const handle = createInvocationHandler({ auth: { kind: 'platform' }, maxBodyBytes: 8192, agentFor: agents, log: deps.log });

  const withToken = async (req: Request): Promise<Response> => {
    if (token === undefined && readToken !== undefined && new URL(req.url).pathname === '/invocations') {
      const read = await readToken();
      if (!read.ok) {
        const correlationId = randomUUID();
        deps.log(logLine(read.error, 'McpTokenUnavailable', { correlationId }));
        const body = toProblemDetails(read.error, { instance: `urn:uuid:${correlationId}` });
        return new Response(JSON.stringify(body), { status: body.status, headers: { 'content-type': PROBLEM_JSON_CONTENT_TYPE } });
      }
      token = read.value;
    }
    return handle(req);
  };
  return ok(createServer(nodeListener(withToken, { maxBodyBytes: 8192, log: deps.log })));
}
