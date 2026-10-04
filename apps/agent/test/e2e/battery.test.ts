import { allowedConnections, blockedConnections } from '../no-network.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HomeIdSchema, TurnReplySchema, type HomeId } from '@cold-reserve/contracts';
import type { AgentLogEntry } from '../../src/agent.js';
import type { AgentConfig } from '../../src/config.js';
import { FakeModel, type FakePolicy } from '../../src/fake-model.js';
import { createHomeAgent } from '../../src/home-agent.js';
import { McpToken } from '../../src/config.js';
import { connectMcp } from '../../src/mcp-tools.js';

// Local E2E (issue #17, part 2): the agent on the Strands loop, the fake model choosing the tool,
// and the REAL MCP server (apps/mcp-server, clear-day simulator) on 127.0.0.1, in its own process.
// The scenario clock is frozen (speed 0), so a direct call to the server reads the same numbers.
const MCP_DIR = join(import.meta.dirname, '..', '..', '..', 'mcp-server');
const TOKEN = randomBytes(24).toString('hex');
let server: ChildProcess;
let url: string;

beforeAll(async () => {
  server = spawn(process.execPath, ['--import', 'tsx', join(MCP_DIR, 'src', 'local.ts')], {
    cwd: MCP_DIR,
    env: { ...process.env, PORT: '0', MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_SCENARIO: 'clear-day', MCP_SCENARIO_START_H: '14', MCP_SCENARIO_SPEED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.resume(); // server logs are not asserted; never let the pipe fill up
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the MCP server did not start within 30 s'));
    }, 30_000);
    server.stdout?.on('data', (d: Buffer) => {
      const found = /listening on (\S+)"/.exec(String(d));
      if (found?.[1]) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
    server.once('exit', (code) => {
      reject(new Error(`the MCP server exited early with ${String(code)}`));
    });
  });
}, 60_000);
afterAll(async () => {
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  await exited;
});

const DEMO: HomeId = HomeIdSchema.parse('demo');

/** The agent as it runs in production (#233): our own MCP session, every tool call named by its turn. */
const homeAgent = (mcpUrl: string, token: string, model: FakeModel, log?: (e: AgentLogEntry) => void) =>
  // The token's home is demo: no sandbox header (connect ignores the home it is given).
  createHomeAgent({ config: config(mcpUrl), home: DEMO, model, connect: () => connectMcp(config(mcpUrl), new McpToken(token), undefined), ...(log ? { log } : {}) });

const config = (mcpUrl: string): AgentConfig => ({
  model: { provider: 'fake' },
  maxTokens: 400,
  maxModelTurns: 7,
  maxToolCalls: 6,
  historyWindowMessages: 12,
  turnDeadlineMs: 7000,
  mcpUrl,
});

/** A port nobody listens on: bind, read it, close. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => {
    resolve();
  }));
  return port;
}

/** The battery reading straight from the server's structuredContent, bypassing the agent. */
async function socFromServer(): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_home_status', arguments: {} } }),
  });
  const body = (await res.json()) as { result: { structuredContent: { batterySocPct: number } } };
  return body.result.structuredContent.batterySocPct;
}

/**
 * Battery questions go to get_home_status; the answer only repeats numbers from the tool result.
 * Strands passes the model the MCP `content` text (the tool's summary), not `structuredContent`.
 */
const socIn = (toolResult: string | undefined) => /Battery at ([\d.]+)%/.exec(toolResult ?? '')?.[1];

const batteryPolicy: FakePolicy = (call) => {
  if (call.toolResults.length === 0) return { toolUse: { name: 'get_home_status', input: {} } };
  const soc = socIn(call.toolResults[0]);
  return { text: soc === undefined ? "I couldn't read the battery." : `Your battery is at ${soc}%. This is simulated data.` };
};

describe("\"What's my battery level?\" through the agent and the local MCP server", () => {
  it("calls get_home_status and answers with the server's own battery reading", async () => {
    const model = new FakeModel(batteryPolicy);
    const turn = await homeAgent(url, TOKEN, model).ask("What's my battery level?", randomUUID());
    if (!turn.ok) throw new Error(turn.error.message);
    expect(model.calls.map((c) => c.toolResults.length)).toEqual([0, 1]);
    expect(TurnReplySchema.parse(turn.value).text).toBe(`Your battery is at ${String(await socFromServer())}%. This is simulated data.`);
  }, 60_000);

  it('receives the tool descriptions of the server (snapshot: every change shows up in review)', async () => {
    const model = new FakeModel(() => ({ text: 'Hello.' }));
    await homeAgent(url, TOKEN, model).ask('Hi', randomUUID());
    expect(model.calls[0]?.tools).toMatchSnapshot();
  }, 60_000);

  it('returns invalid_config (not retryable) when the MCP server refuses the token with 401', async () => {
    const logs: AgentLogEntry[] = [];
    const turn = await homeAgent(url, 'x'.repeat(48), new FakeModel(batteryPolicy), (e) => logs.push(e)).ask("What's my battery level?", randomUUID());
    expect(turn).toMatchObject({ ok: false, error: { code: 'invalid_config', retryable: false } });
    expect(logs).toMatchObject([{ level: 'error', component: 'agent', code: 'invalid_config', category: 'internal', errorName: 'Error', details: { httpStatus: 401 } }]);
  }, 60_000);

  it('returns agent_unavailable (retryable) when the MCP server is down', async () => {
    const down = `http://127.0.0.1:${String(await closedPort())}/mcp`;
    const turn = await homeAgent(down, TOKEN, new FakeModel(batteryPolicy)).ask("What's my battery level?", randomUUID());
    expect(turn).toMatchObject({ ok: false, error: { code: 'agent_unavailable', retryable: true } });
  }, 60_000);

  it('only ever connected to the loopback', () => {
    expect(blockedConnections).toEqual([]);
    expect(allowedConnections).toContain('127.0.0.1');
  });
});
