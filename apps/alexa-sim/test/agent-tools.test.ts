import { ApplyPlanOutputSchema, SetPreferencesOutputSchema, err, ok, toolError } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/agent/agent.js';
import { withScriptedFallback } from '../src/agent/fallback-agent.js';
import { createRemoteAgent } from '../src/agent/remote-agent.js';
import script from '../src/agent/script.v1.json' with { type: 'json' };
import { createScriptedAgent } from '../src/agent/scripted-agent.js';

// Card actions reach the agent as tool calls (MCP Apps callServerTool through the host).

const ctx = { correlationId: 'c' };
const scripted = (degraded = false) => {
  const created = createScriptedAgent(script, { degraded });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
};

describe('ScriptedAgent.callTool: simulated actions on the scripted home', () => {
  it('applies the scripted plan', async () => {
    const result = await scripted().callTool('apply_plan', { planId: 'plan_7Hq2mX9vK3' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(ApplyPlanOutputSchema.parse(result.structuredContent).plan.status).toBe('applied');
  });

  it('refuses a plan it does not know, as the tool would', async () => {
    const result = await scripted().callTool('apply_plan', { planId: 'plan_unknown_1' }, ctx);
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'plan_not_found' } });
  });

  it('saves a preferences change and returns the new view', async () => {
    const result = await scripted().callTool('set_preferences', { comfortC: { cooling: 24 }, roomPriority: ['bedroom-1', 'study', 'living'], confirmed: true }, ctx);
    const out = SetPreferencesOutputSchema.parse(result.structuredContent);
    expect(out.preferences.comfortC.cooling).toBe(24);
    expect(out.preferences.roomPriority).toEqual(['bedroom-1', 'study', 'living']);
    expect(out.changes.map((c) => c.field)).toEqual(['comfortC.cooling', 'roomPriority']);
  });

  it('in degraded mode never performs an action: an honest error, nothing changed', async () => {
    const result = await scripted(true).callTool('apply_plan', { planId: 'plan_7Hq2mX9vK3' }, ctx);
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'agent_unavailable', retryable: true } });
  });
});

describe('canCallTools: the host offers card actions only when the agent can run them', () => {
  it('is true for the scripted home, false for its degraded mode and for the remote agent until #55', () => {
    expect(scripted().canCallTools).toBe(true);
    expect(scripted(true).canCallTools).toBe(false);
    expect(createRemoteAgent({ baseUrl: 'http://sim-api.test', timeoutMs: 1_000 }).canCallTools).toBe(false);
    expect(withScriptedFallback(createRemoteAgent({ baseUrl: 'http://sim-api.test', timeoutMs: 1_000 }), scripted(true)).canCallTools).toBe(false);
  });
});

describe('card actions with the remote agent', () => {
  it('are refused honestly until sim-api has a tools endpoint (#55)', async () => {
    const remote = createRemoteAgent({ baseUrl: 'http://sim-api.test', timeoutMs: 1_000, fetch: () => Promise.reject(new Error('unused')) });
    const result = await remote.callTool('apply_plan', { planId: 'plan_7Hq2mX9vK3' }, ctx);
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'agent_unavailable' } });
  });

  it('never fall back to the script: an action goes to the primary agent only', async () => {
    const primary: Agent = {
      canCallTools: false,
      ask: () => Promise.resolve(err(toolError('agent_unavailable', 'Down.'))),
      callTool: () => Promise.resolve({ isError: true, content: [], structuredContent: toolError('agent_unavailable', 'Down.') }),
    };
    const fallback: Agent = { canCallTools: true, ask: () => Promise.resolve(ok({ text: 'x' })), callTool: () => Promise.reject(new Error('the script must not act')) };
    const result = await withScriptedFallback(primary, fallback).callTool('apply_plan', { planId: 'plan_7Hq2mX9vK3' }, ctx);
    expect(result.isError).toBe(true);
  });
});
