import './no-network.js';
import { HomeIdSchema, PlanSchema, TurnReplySchema } from '@cold-reserve/contracts';
import { examplePlan } from '@cold-reserve/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/config.js';
import { FakeModel, type FakePolicy } from '../src/fake-model.js';
import { createHomeAgent } from '../src/home-agent.js';
import type { AgentLogEntry } from '../src/log.js';
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

describe('createHomeAgent: two turns at once for the same home (review of #121)', () => {
  it('runs them one after the other, each with its own cards, status and correlation id', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = session();
    // The first turn's plan_comfort waits until the second turn has been asked.
    const s: McpSession = {
      listTools: () => base.listTools(),
      callTool: async (name, args, signal, correlationId) => {
        if (name === 'plan_comfort') await gate;
        return base.callTool(name, args, signal, correlationId);
      },
    };
    const agent = createHomeAgent({ config: CONFIG, home: HOME, model: new FakeModel(policy), connect: () => Promise.resolve(s) });

    const first = agent.ask('Make a plan', 'turn-a');
    const second = agent.ask("What's my battery level?", 'turn-b');
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toMatchObject({ ok: true, value: { text: 'Plan proposed.', cards: [{ tool: 'plan_comfort' }] } });
    expect(a.ok && a.value.status).toBeUndefined();
    expect(b).toMatchObject({ ok: true, value: { text: 'Battery at 45%.', status: STATUS } });
    expect(b.ok && b.value.cards).toBeUndefined();
    expect(base.correlationIds).toEqual(['turn-a', 'turn-b']);
  });

  it('a turn that throws (a bug) does not block the next one', async () => {
    let attempts = 0;
    const connect = () => (++attempts === 1 ? Promise.reject(new RangeError('bug while connecting')) : Promise.resolve(session()));
    const agent = createHomeAgent({ config: CONFIG, home: HOME, model: new FakeModel(policy), connect });
    const first = agent.ask("What's my battery level?", 'turn-a');
    const second = agent.ask("What's my battery level?", 'turn-b');
    await expect(first).rejects.toThrow(RangeError);
    expect(await second).toMatchObject({ ok: true, value: { text: 'Battery at 45%.' } });
  });

  it('keeps at most one question waiting per home: a third one is rate limited, the others still answer', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = session();
    const s: McpSession = {
      listTools: () => base.listTools(),
      callTool: async (name, args, signal, correlationId) => {
        await gate;
        return base.callTool(name, args, signal, correlationId);
      },
    };
    const logs: AgentLogEntry[] = [];
    const agent = createHomeAgent({ config: CONFIG, home: HOME, model: new FakeModel(policy), connect: () => Promise.resolve(s), log: (e) => logs.push(e) });
    const first = agent.ask('Battery?', 'turn-a');
    const second = agent.ask('Battery?', 'turn-b');
    const third = await agent.ask('Battery?', 'turn-c');
    expect(third).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded', category: 'rate_limited', retryAfterMs: CONFIG.turnDeadlineMs } });
    expect(logs).toMatchObject([{ code: 'demo_quota_exceeded', correlationId: 'turn-c' }]);
    release();
    expect((await first).ok && (await second).ok).toBe(true);
  });

  it('counts the time spent waiting toward the deadline of the waiting question', async () => {
    let now = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = session();
    const s: McpSession = {
      listTools: () => base.listTools(),
      callTool: async (name, args, signal, correlationId) => {
        if (correlationId === 'turn-a') {
          await gate;
          now += CONFIG.turnDeadlineMs; // the first turn used the whole budget of the second one
        }
        return base.callTool(name, args, signal, correlationId);
      },
    };
    const agent = createHomeAgent({ config: CONFIG, home: HOME, model: new FakeModel(policy), connect: () => Promise.resolve(s), now: () => now });
    const first = agent.ask('Battery?', 'turn-a');
    const second = agent.ask('Battery?', 'turn-b');
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: false, error: { code: 'agent_timeout' } });
    expect(base.correlationIds).toEqual(['turn-a']);
  });

  it('starts a fresh agent after a timeout, so a late tool result never lands in the next turn', async () => {
    const quick = { ...CONFIG, turnDeadlineMs: 50 };
    let release: () => void = () => undefined;
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened = 0;
    const connect = () => {
      const base = session();
      const first = ++opened === 1;
      return Promise.resolve<McpSession>({
        listTools: () => base.listTools(),
        // The first session's plan_comfort ignores the cancel signal and answers late.
        callTool: async (name, args, signal, correlationId) => {
          if (first) await late;
          return base.callTool(name, args, signal, correlationId);
        },
      });
    };
    const agent = createHomeAgent({ config: quick, home: HOME, model: new FakeModel(policy), connect });
    expect(await agent.ask('Make a plan', 'turn-a')).toMatchObject({ ok: false, error: { code: 'agent_timeout' } });
    const next = agent.ask("What's my battery level?", 'turn-b');
    release();
    const reply = await next;
    expect(opened).toBe(2);
    expect(reply).toMatchObject({ ok: true, value: { text: 'Battery at 45%.' } });
    expect(reply.ok && reply.value.cards).toBeUndefined();
  });
});

