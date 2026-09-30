import './no-network.js';
import { PRODUCT_NAME } from '@cold-reserve/i18n';
import { ModelError, tool } from '@strands-agents/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../src/agent.js';
import type { AgentConfig } from '../src/config.js';
import { FakeModel } from '../src/fake-model.js';
import { blockedConnections } from './no-network.js';

/** Unwraps a successful turn; a failed one fails the test with its code. */
async function answered(pending: ReturnType<ReturnType<typeof createAgent>['ask']>) {
  const turn = await pending;
  if (!turn.ok) throw new Error(`turn failed: ${turn.error.code}`);
  return turn.value;
}

const CONFIG: AgentConfig = {
  model: { provider: 'fake' },
  maxTokens: 400,
  maxModelTurns: 7,
  maxToolCalls: 6,
  historyWindowMessages: 12,
  turnDeadlineMs: 7000,
  mcpUrl: 'http://127.0.0.1:3316/mcp',
};

/** A local stand-in for an MCP tool: counts its executions. */
function batteryTool() {
  let runs = 0;
  const t = tool({
    name: 'get_home_status',
    description: 'Test-only battery reading.',
    inputSchema: z.object({}),
    callback: () => {
      runs++;
      return { batterySocPct: 64 };
    },
  });
  return { tool: t, runs: () => runs };
}

describe('createAgent on the Strands loop with the fake model', () => {
  it('sends the versioned system prompt and caps the answer at maxTokens', async () => {
    const model = new FakeModel(() => ({ text: 'Hello.' }));
    const agent = createAgent({ config: CONFIG, model, tools: [] });
    await agent.ask('Hi');
    expect(model.getConfig().maxTokens).toBe(400);
    expect(model.calls[0]?.systemPrompt).toContain(PRODUCT_NAME);
  });

  it('runs a tool call and answers with its result', async () => {
    const battery = batteryTool();
    const model = new FakeModel((call) =>
      call.toolResults.length === 0 ? { toolUse: { name: 'get_home_status', input: {} } } : { text: `The battery is at ${call.toolResults[0] ?? '?'}.` },
    );
    const turn = await answered(createAgent({ config: CONFIG, model, tools: [battery.tool] }).ask("What's my battery level?"));
    expect(turn.toolCalls).toEqual(['get_home_status']);
    expect(turn.text).toContain('64');
    expect(model.calls[0]?.toolNames).toEqual(['get_home_status']);
  });

  it('stops after maxModelTurns model calls (limits.turns)', async () => {
    const model = new FakeModel(() => ({ toolUse: { name: 'get_home_status', input: {} } }));
    const turn = await answered(createAgent({ config: CONFIG, model, tools: [batteryTool().tool] }).ask('Loop forever'));
    expect(model.calls).toHaveLength(7);
    expect(turn.stopReason).toBe('limitTurns');
  });

  it('never runs more than maxToolCalls tools in one turn, whatever the model asks', async () => {
    const battery = batteryTool();
    const model = new FakeModel(() => ({ toolUse: { name: 'get_home_status', input: {} } }));
    await createAgent({ config: { ...CONFIG, maxModelTurns: 20 }, model, tools: [battery.tool] }).ask('Loop forever');
    expect(battery.runs()).toBe(6);
  });

  it('resets the tool-call budget on every turn', async () => {
    const battery = batteryTool();
    const model = new FakeModel((call) => (call.toolResults.length < 4 ? { toolUse: { name: 'get_home_status', input: {} } } : { text: 'Done.' }));
    const agent = createAgent({ config: CONFIG, model, tools: [battery.tool] });
    await agent.ask('First');
    await agent.ask('Second');
    expect(battery.runs()).toBe(8);
  });

  it('keeps at most historyWindowMessages messages of history', async () => {
    const model = new FakeModel(() => ({ text: 'Fine.' }));
    const agent = createAgent({ config: CONFIG, model, tools: [] });
    for (let i = 0; i < 10; i++) await agent.ask(`Question ${String(i)}`);
    expect(agent.historyLength()).toBeLessThanOrEqual(12);
    expect(Math.max(...model.calls.map((c) => c.messageCount))).toBeLessThanOrEqual(13);
  });

  it('turns a model outage into agent_unavailable (retryable), never a throw', async () => {
    const model = new FakeModel(() => {
      throw new ModelError('model down at /secret/path');
    });
    const turn = await createAgent({ config: CONFIG, model, tools: [] }).ask('Hi');
    expect(turn).toMatchObject({ ok: false, error: { code: 'agent_unavailable', category: 'dependency_unavailable', retryable: true } });
    expect(JSON.stringify(turn)).not.toContain('/secret/path');
  });

  it('rethrows a bug (TypeError) instead of hiding it as a failed turn', async () => {
    const model = new FakeModel(() => {
      throw new TypeError('policy is not a function');
    });
    await expect(createAgent({ config: CONFIG, model, tools: [] }).ask('Hi')).rejects.toThrow(TypeError);
  });

  it('answers agent_timeout at the turn deadline, even while a tool still runs', async () => {
    const slow = tool({
      name: 'get_home_status',
      description: 'Test-only tool that never answers in time.',
      inputSchema: z.object({}),
      callback: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve('late');
          }, 5_000).unref();
        }),
    });
    const model = new FakeModel(() => ({ toolUse: { name: 'get_home_status', input: {} } }));
    const started = Date.now();
    const turn = await createAgent({ config: { ...CONFIG, turnDeadlineMs: 100 }, model, tools: [slow] }).ask('Battery?');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(turn).toMatchObject({ ok: false, error: { code: 'agent_timeout', retryable: true } });
  });

  it('makes no outbound connection while running', () => {
    expect(blockedConnections).toEqual([]);
  });
});
