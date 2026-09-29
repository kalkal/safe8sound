import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

describe('simulator config', () => {
  it('defaults to the ScriptedAgent with explicit timeouts', () => {
    expect(parseConfig({}, '', false)).toEqual({
      ok: true,
      value: { agent: 'scripted', simApiUrl: undefined, agentTimeoutMs: 8_000, turnBudgetMs: 10_000 },
    });
  });

  it('reads the remote agent settings from the environment', () => {
    const env = { VITE_AGENT: 'remote', VITE_SIM_API_URL: 'https://sim.example.test', VITE_AGENT_TIMEOUT_MS: '4000', VITE_TURN_BUDGET_MS: '6000' };
    expect(parseConfig(env, '', false)).toMatchObject({ ok: true, value: { agent: 'remote', simApiUrl: 'https://sim.example.test', agentTimeoutMs: 4000 } });
  });

  it('rejects a remote agent without a sim-api URL, and a turn budget shorter than the agent timeout', () => {
    expect(parseConfig({ VITE_AGENT: 'remote' }, '', false)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(parseConfig({ VITE_AGENT_TIMEOUT_MS: '9000', VITE_TURN_BUDGET_MS: '5000' }, '', false)).toMatchObject({ ok: false });
  });

  it('lets ?agent= switch the agent only in dev (fault-injection tests), with a same-origin sim-api', () => {
    expect(parseConfig({}, '?agent=remote', true)).toMatchObject({ ok: true, value: { agent: 'remote', simApiUrl: '/sim-api' } });
    expect(parseConfig({}, '?agent=remote', false)).toMatchObject({ ok: true, value: { agent: 'scripted' } });
  });
});
