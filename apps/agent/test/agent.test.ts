import './no-network.js';
import { PRODUCT_NAME } from '@cold-reserve/i18n';
import { tool } from '@strands-agents/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../src/agent.js';
import type { AgentConfig } from '../src/config.js';
import { FakeModel } from '../src/fake-model.js';
import { blockedConnections } from './no-network.js';

const CONFIG: AgentConfig = {
  model: { provider: 'fake' },
  maxTokens: 400,
  maxModelTurns: 7,
  maxToolCalls: 6,
  historyWindowMessages: 12,
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
    const turn = await createAgent({ config: CONFIG, model, tools: [battery.tool] }).ask("What's my battery level?");
    expect(turn.toolCalls).toEqual(['get_home_status']);
    expect(turn.text).toContain('64');
    expect(model.calls[0]?.toolNames).toEqual(['get_home_status']);
  });

  it('stops after maxModelTurns model calls (limits.turns)', async () => {
    const model = new FakeModel(() => ({ toolUse: { name: 'get_home_status', input: {} } }));
    const turn = await createAgent({ config: CONFIG, model, tools: [batteryTool().tool] }).ask('Loop forever');
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

  it('makes no outbound connection while running', () => {
    expect(blockedConnections).toEqual([]);
  });
});
