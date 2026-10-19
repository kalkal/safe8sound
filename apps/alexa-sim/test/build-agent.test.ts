import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAgent } from '../src/agent/index.js';
import script from '../src/agent/script.v1.json' with { type: 'json' };
import type { SimConfig } from '../src/config.js';

const base: SimConfig = {
  agent: 'scripted', simApiUrl: undefined, agentTimeoutMs: 1_000, turnBudgetMs: 2_000, homeTimeZone: 'Europe/Rome', phone: 'scripted', phonePollMs: 5_000, demo: false, view: 'full', layout: 'alexa-echo-show', demoControls: true,
  voice: { speech: 'fake', lang: 'en-US', speakReplies: false, listenTimeoutMs: 1, speakStartTimeoutMs: 1, studioVoiceTimeoutMs: 1, speakTimeoutBaseMs: 1, speakTimeoutPerCharMs: 1 },
};
const remote: SimConfig = { ...base, agent: 'remote', simApiUrl: 'http://sim-api.test' };
const ctx = { correlationId: 'c' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildAgent', () => {
  it('builds the ScriptedAgent by default and never touches the network', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const agent = buildAgent(base);
    if (!agent.ok) throw new Error(agent.error.message);
    expect(await agent.value.ask("What's my battery level?", ctx)).toMatchObject({ ok: true, value: { status: script.status } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('builds the RemoteAgent with the scripted degraded mode behind it', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    vi.stubGlobal('fetch', fetch);
    const agent = buildAgent(remote);
    if (!agent.ok) throw new Error(agent.error.message);
    expect(await agent.value.ask("What's my battery level?", ctx)).toMatchObject({
      ok: true,
      value: { status: script.status, degradedBy: 'agent_unavailable' },
    });
    expect(fetch).toHaveBeenCalledWith('http://sim-api.test/v1/turns', expect.anything());
  });

  it('refuses to build any agent when the script is broken, even with a remote agent configured', () => {
    const broken = { ...script, version: 2 };
    expect(buildAgent(remote, broken)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(buildAgent(base, broken)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });

  it('remote down + "Apply the plan": an honest answer, nothing claimed as applied, no card', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fetch failed'))));
    const agent = buildAgent(remote);
    if (!agent.ok) throw new Error(agent.error.message);
    const answer = await agent.value.ask('Apply the plan', ctx);
    expect(answer).toEqual({ ok: true, value: { text: script.degradedFallback, degradedBy: 'agent_unavailable' } });
    expect(JSON.stringify(answer)).not.toMatch(/applied/i);
  });
});
