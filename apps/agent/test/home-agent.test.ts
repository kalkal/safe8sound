import './no-network.js';
import { HomeIdSchema, PlanSchema, TurnReplySchema } from '@cold-reserve/contracts';
import { examplePlan } from '@cold-reserve/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/config.js';
import { FakeModel, type FakePolicy } from '../src/fake-model.js';
import { createHomeAgent } from '../src/home-agent.js';
import type { McpSession } from '../src/mcp-tools.js';

const CONFIG: AgentConfig = {
  model: { provider: 'fake' },
  maxTokens: 400,
  maxModelTurns: 7,
  maxToolCalls: 6,
  historyWindowMessages: 12,
  turnDeadlineMs: 7000,
  mcpUrl: 'http://127.0.0.1:3316/mcp',
};
const HOME = HomeIdSchema.parse('demo#0123456789abcdef');
const PLAN = PlanSchema.parse(examplePlan()) as unknown as Record<string, unknown>;
const STATUS = { batterySocPct: 45, origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated' }, ts: '2026-07-15T12:00:00.000Z' };

function session(): McpSession & { opened: number; correlationIds: (string | undefined)[] } {
  const s = {
    opened: 0,
    listTools: () => {
      s.opened++;
      return Promise.resolve([
        { name: 'plan_comfort', inputSchema: { type: 'object' as const } },
        { name: 'get_home_status', inputSchema: { type: 'object' as const } },
      ]);
    },
    correlationIds: [] as (string | undefined)[],
    callTool: (name: string, _args: Record<string, unknown>, _signal?: AbortSignal, correlationId?: string) => {
      s.correlationIds.push(correlationId);
      return Promise.resolve(
        name === 'plan_comfort'
          ? { content: [{ type: 'text', text: 'Plan proposed.' }], structuredContent: PLAN }
          : { content: [{ type: 'text', text: 'Battery at 45%.' }], structuredContent: { ...STATUS, homeId: HOME } },
      );
    },
  };
  return s;
}

/** Calls the tool named in the question once, then answers with its text. */
const policy: FakePolicy = (call) => {
  const tool = call.lastUserText.includes('plan') ? 'plan_comfort' : 'get_home_status';
  return call.toolResults.length === 0 ? { toolUse: { name: tool, input: {} } } : { text: call.toolResults[0] ?? '' };
};

describe('createHomeAgent: one sandbox home, its agent, its MCP session and its cards', () => {
  it('answers a TurnReply with the plan card the tool produced', async () => {
    const agent = createHomeAgent({ config: CONFIG, home: HOME, model: new FakeModel(policy), connect: () => Promise.resolve(session()) });
    const reply = await agent.ask('Make a plan for tomorrow', '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60');
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(TurnReplySchema.parse(reply.value)).toEqual({ text: 'Plan proposed.', cards: [{ tool: 'plan_comfort', result: PLAN }] });
  });

  it('adds the status facts when get_home_status ran, and keeps cards to their own turn', async () => {
    const agent = createHomeAgent({ config: CONFIG, home: HOME, model: new FakeModel(policy), connect: () => Promise.resolve(session()) });
    await agent.ask('Make a plan', 'a');
    const reply = await agent.ask("What's my battery level?", 'b');
    expect(reply).toMatchObject({ ok: true, value: { text: 'Battery at 45%.', status: STATUS } });
    expect(reply.ok && reply.value.cards).toBeUndefined();
  });

  it('carries the correlation id of the invocation to the MCP calls of the turn', async () => {
    const s = session();
    const agent = createHomeAgent({ config: CONFIG, home: HOME, model: new FakeModel(policy), connect: () => Promise.resolve(s) });
    await agent.ask('Battery?', '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60');
    expect(s.correlationIds).toEqual(['0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60']);
  });

  it('opens the MCP session once and reuses it across turns', async () => {
    const s = session();
    const agent = createHomeAgent({ config: CONFIG, home: HOME, model: new FakeModel(policy), connect: () => Promise.resolve(s) });
    await agent.ask('Battery?', 'a');
    await agent.ask('Battery?', 'b');
    expect(s.opened).toBe(1);
  });

  it('answers agent_unavailable when the MCP server cannot be reached', async () => {
    const agent = createHomeAgent({
      config: CONFIG,
      home: HOME,
      model: new FakeModel(policy),
      connect: () => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) })),
    });
    expect(await agent.ask('Battery?', 'a')).toMatchObject({ ok: false, error: { code: 'agent_unavailable', retryable: true } });
  });
});
