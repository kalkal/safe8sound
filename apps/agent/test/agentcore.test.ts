import './no-network.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProblemDetailsSchema, err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAgentCoreServer } from '../src/agentcore.js';
import { McpToken } from '../src/config.js';

// The AgentCore runtime entry (G1a): GET /ping and POST /invocations on the port the platform gives, no
// bearer (IAM/SigV4 is done by InvokeAgentRuntime, decided in #17), the model and limits from config.

const ENV = { AGENT_MODEL_PROVIDER: 'fake', AGENT_MCP_URL: 'http://127.0.0.1:39999/mcp', AGENT_MCP_TOKEN: 'm'.repeat(40) };
let server: Server | undefined;

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running) {
    await new Promise<void>((resolve) => {
      running.close(() => {
        resolve();
      });
    });
  }
});

async function listen(env: Record<string, string>, mcpToken?: () => Promise<Result<McpToken, ErrorEnvelope>>) {
  const built = buildAgentCoreServer(env, { log: () => undefined, ...(mcpToken === undefined ? {} : { mcpToken }) });
  if (!built.ok) throw new Error(built.error.message);
  const running = built.value;
  server = running;
  await new Promise<void>((resolve) => running.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((running.address() as AddressInfo).port)}`;
}

describe('buildAgentCoreServer', () => {
  it('answers /ping as Healthy', async () => {
    const base = await listen(ENV);
    const res = await fetch(`${base}/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'Healthy' });
  });

  it('takes an invocation without a bearer token: the platform has authenticated the caller', async () => {
    const base = await listen(ENV);
    // No MCP server listens here: the turn fails as agent_unavailable, never as missing_token.
    const res = await fetch(`${base}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Hi', home: 'demo#0123456789abcdef' }) });
    const problem = ProblemDetailsSchema.parse(await res.json());
    expect(problem.code).not.toBe('missing_token');
    expect(problem.code).toBe('agent_unavailable');
  });

  it('refuses a broken config at startup, before listening', () => {
    expect(buildAgentCoreServer({ ...ENV, AGENT_MODEL_PROVIDER: 'bedrock' }, { log: () => undefined })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(buildAgentCoreServer({ ...ENV, AGENT_MAX_SESSIONS: 'abc' }, { log: () => undefined })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });

  it('reads the MCP token on demand: SSM down is a 503 config_unavailable, /ping stays healthy, the next call tries again', async () => {
    let calls = 0;
    const provider = () => {
      calls++;
      return Promise.resolve(calls === 1 ? err(toolError('config_unavailable', 'SSM is slow.')) : ok(new McpToken('m'.repeat(40))));
    };
    const withoutToken = { AGENT_MODEL_PROVIDER: ENV.AGENT_MODEL_PROVIDER, AGENT_MCP_URL: ENV.AGENT_MCP_URL };
    const base = await listen(withoutToken, provider);
    const invoke = () => fetch(`${base}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Hi', home: 'demo#0123456789abcdef' }) });
    const first = await invoke();
    expect(first.status).toBe(503);
    expect(ProblemDetailsSchema.parse(await first.json()).code).toBe('config_unavailable');
    expect((await fetch(`${base}/ping`)).status).toBe(200);
    expect(ProblemDetailsSchema.parse(await (await invoke()).json()).code).toBe('agent_unavailable');
    expect(calls).toBe(2);
  });
});
