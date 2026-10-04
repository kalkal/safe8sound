import { allowedConnections, blockedConnections } from '../no-network.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { HomeIdSchema, TurnReplySchema } from '@cold-reserve/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../src/config.js';
import { McpToken } from '../../src/config.js';
import { FakeModel, type FakePolicy } from '../../src/fake-model.js';
import { createHomeAgent } from '../../src/home-agent.js';
import { connectMcp } from '../../src/mcp-tools.js';

// #230 end to end: the agent (our MCP wrapper, as in production) and the REAL MCP server in its own process,
// heatwave at 14:00, a visitor sandbox. A model that proposes and applies in the same turn is refused by the
// server; the next turn, after the person's yes, and a card tap both apply.
const MCP_DIR = join(import.meta.dirname, '..', '..', '..', 'mcp-server');
const TOKEN = randomBytes(24).toString('hex');
const HOME = HomeIdSchema.parse('demo#0123456789abcdef');
let server: ChildProcess;
let url: string;

beforeAll(async () => {
  server = spawn(process.execPath, ['--import', 'tsx', join(MCP_DIR, 'src', 'local.ts')], {
    cwd: MCP_DIR,
    env: { ...process.env, PORT: '0', MCP_CLIENTS: `agent@demo#*=${TOKEN}`, MCP_SCENARIO: 'heatwave', MCP_SCENARIO_START_H: '14', MCP_SCENARIO_SPEED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.resume();
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

const config = (mcpUrl: string): AgentConfig => ({
  model: { provider: 'fake' },
  maxTokens: 400,
  maxModelTurns: 7,
  maxToolCalls: 6,
  historyWindowMessages: 12,
  turnDeadlineMs: 15_000,
  mcpUrl,
});

const planIdIn = (text: string | undefined) => /planId (plan_[A-Za-z0-9]+)/.exec(text ?? '')?.[1];

/** A card tap: sim-api's call, with the sandbox header and a correlation id, but no turn header. */
async function cardTap(planId: string, correlationId: string): Promise<{ isError?: boolean; structuredContent?: { plan?: { status?: string } } }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
      'mcp-protocol-version': '2025-11-25',
      'x-cold-reserve-home': HOME,
      'x-correlation-id': correlationId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'apply_plan', arguments: { planId } } }),
  });
  return ((await res.json()) as { result: { isError?: boolean; structuredContent?: { plan?: { status?: string } } } }).result;
}

describe('the person confirms before the agent applies (#230)', () => {
  it('propose and apply in one turn: the server refuses, the answer asks; a card tap then applies', async () => {
    let planId: string | undefined;
    // The bad model: plan_comfort, then at once apply_plan, then whatever the last tool said.
    const eager: FakePolicy = (call) => {
      if (call.toolResults.length === 0) return { toolUse: { name: 'plan_comfort', input: { goal: 'cool' } } };
      if (call.toolResults.length === 1) {
        planId = planIdIn(call.toolResults[0]);
        return { toolUse: { name: 'apply_plan', input: { planId } } };
      }
      return { text: (call.toolResults[1] ?? '').replace(/^Error: /, '') };
    };
    const agent = createHomeAgent({ config: config(url), home: HOME, model: new FakeModel(eager), connect: (h) => connectMcp(config(url), new McpToken(TOKEN), h) });
    const turn = randomUUID();
    const reply = await agent.ask("It's going to be 36 degrees tomorrow. Keep Grandpa cool.", turn);
    if (!reply.ok) throw new Error(reply.error.message);
    const answer = TurnReplySchema.parse(reply.value);
    expect(planId).toMatch(/^plan_/);
    expect(answer.text).toMatch(/^Not applied: the person has not confirmed yet\./);
    expect(answer.text).not.toMatch(/is active|applied\./i);
    // The card the person sees is the plan, still proposed; their tap applies it, in the same turn.
    expect(answer.cards?.map((c) => (c as { tool: string }).tool)).toEqual(['plan_comfort']);
    const tapped = await cardTap(planId ?? '', turn);
    expect(tapped.isError).toBeFalsy();
    expect(tapped.structuredContent?.plan?.status).toBe('applied');
  }, 60_000);

  it('a yes in the next turn applies the plan proposed in the turn before', async () => {
    let planId: string | undefined;
    const polite: FakePolicy = (call) => {
      if (/yes/i.test(call.lastUserText)) {
        return call.toolResults.length === 0 ? { toolUse: { name: 'apply_plan', input: { planId } } } : { text: call.toolResults[0] ?? '' };
      }
      if (call.toolResults.length === 0) return { toolUse: { name: 'plan_comfort', input: { goal: 'cool' } } };
      planId = planIdIn(call.toolResults[0]);
      return { text: 'Here is the plan. Shall I apply it?' };
    };
    const agent = createHomeAgent({ config: config(url), home: HOME, model: new FakeModel(polite), connect: (h) => connectMcp(config(url), new McpToken(TOKEN), h) });
    const first = await agent.ask('Keep Grandpa cool tomorrow.', randomUUID());
    expect(first.ok && first.value.text).toBe('Here is the plan. Shall I apply it?');
    const second = await agent.ask('Yes, apply it.', randomUUID());
    if (!second.ok) throw new Error(second.error.message);
    expect(second.value.text).toBe(`Plan ${planId ?? ''} applied.`);
  }, 60_000);

  it('only ever connected to the loopback', () => {
    expect(blockedConnections).toEqual([]);
    expect(allowedConnections).toContain('127.0.0.1');
  });
});
