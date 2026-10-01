import './no-network.js';
import { HomeIdSchema, ok, type HomeId } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { loadInvokeToken, loadMaxSessions } from '../src/config.js';
import type { HomeAgent } from '../src/invocations.js';
import { homeAgents } from '../src/sessions.js';

const home = (n: number) => HomeIdSchema.parse(`demo#${n.toString(16).padStart(16, '0')}`);

describe('homeAgents: one agent per sandbox home, a bounded number in memory', () => {
  it('reuses the agent of a home and evicts the least recently used past the cap', () => {
    const created: HomeId[] = [];
    const agents = homeAgents({
      max: 2,
      create: (h) => {
        created.push(h);
        const agent: HomeAgent = { ask: () => Promise.resolve(ok({ text: 'hi' })) };
        return agent;
      },
    });
    const a = agents(home(1));
    expect(agents(home(1))).toBe(a);
    agents(home(2));
    agents(home(1)); // home 1 is now the most recent
    agents(home(3)); // evicts home 2
    agents(home(2)); // created again
    expect(created).toEqual([home(1), home(2), home(3), home(2)]);
  });
});

describe('loadInvokeToken: the token sim-api uses to invoke the agent, separate from the MCP one', () => {
  it('reads AGENT_INVOKE_TOKEN (32+ characters) and keeps it out of logs', () => {
    const result = loadInvokeToken({ AGENT_INVOKE_TOKEN: 'v'.repeat(40) });
    expect(result.ok && result.value.reveal()).toBe('v'.repeat(40));
    expect(JSON.stringify(result)).not.toContain('v'.repeat(40));
  });

  it.each([{}, { AGENT_INVOKE_TOKEN: 'short' }])('fails with invalid_config on %j', (env) => {
    expect(loadInvokeToken(env)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});

describe('loadMaxSessions: how many sandbox homes stay in memory (review of #121)', () => {
  it('reads AGENT_MAX_SESSIONS, 50 by default', () => {
    expect(loadMaxSessions({})).toEqual({ ok: true, value: 50 });
    expect(loadMaxSessions({ AGENT_MAX_SESSIONS: '10' })).toEqual({ ok: true, value: 10 });
  });

  it.each(['abc', '0', '-3', '1.5', '100000', ''])('fails with invalid_config on %j (NaN would mean no limit)', (value) => {
    expect(loadMaxSessions({ AGENT_MAX_SESSIONS: value })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});
