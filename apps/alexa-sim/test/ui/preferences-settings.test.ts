import { toolError, type GetPreferencesOutput } from '@cold-reserve/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, ToolCallResult } from '../../src/agent/agent.js';
import { SCRIPT_FIXTURES } from '../../src/agent/script-fixtures.js';
import type { LogEvent } from '../../src/log.js';
import { fetchPreferences, savePreferences } from '../../src/ui/preferences-settings.js';

// #402: the settings section reads the home's preferences and saves one confirmed change at a time, then reads back
// what is stored. Every outcome is a value and a log line with the correlation id.

const ctx = { correlationId: 'corr-402' };
const card = SCRIPT_FIXTURES.preferences();
if (card.tool !== 'get_preferences') throw new Error('fixture');
const view: GetPreferencesOutput = card.result;
const reply = (structuredContent: unknown, isError = false): ToolCallResult => ({ content: [{ type: 'text', text: 'x' }], structuredContent: structuredContent as Record<string, unknown>, ...(isError ? { isError } : {}) });

const agentAnswering = (answers: Record<string, ToolCallResult | Error>) => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const agent = {
    canCallTools: true,
    ask: () => Promise.reject(new Error('unused')),
    callTool: (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      const a = answers[name];
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    },
  } as unknown as Agent;
  return { agent, calls };
};

describe('fetchPreferences', () => {
  it('reads the preferences with their hard limits', async () => {
    const { agent } = agentAnswering({ get_preferences: reply(view) });
    expect(await fetchPreferences(agent, ctx)).toEqual({ ok: true, value: view });
  });

  it('a tool error or a result that breaks the contract is an error value, logged with the correlation id', async () => {
    const log = vi.fn<(e: LogEvent) => void>();
    const refused = agentAnswering({ get_preferences: reply({ code: 'invalid_input' }, true) });
    expect(await fetchPreferences(refused.agent, ctx, log)).toMatchObject({ ok: false });
    const odd = agentAnswering({ get_preferences: reply({ nope: 1 }) });
    expect(await fetchPreferences(odd.agent, ctx, log)).toMatchObject({ ok: false, error: { code: 'output_schema_violation' } });
    const down = agentAnswering({ get_preferences: new Error('network') });
    expect(await fetchPreferences(down.agent, ctx, log)).toMatchObject({ ok: false, error: { code: 'agent_unavailable' } });
    expect(log).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.every(([e]) => e.correlationId === 'corr-402' && e.level === 'warn')).toBe(true);
  });
});

describe('savePreferences', () => {
  const stored = { ...view.preferences, comfortC: { ...view.preferences.comfortC, cooling: 24 as never } };
  const changes = [{ ts: '2026-07-15T12:00:00+02:00', field: 'comfortC.cooling', from: 25, to: 24, by: 'user' as const, confirmed: true as const }];

  it('sends the draft as one confirmed write, returns what the tool stored (no second read) and logs the fields', async () => {
    const log = vi.fn<(e: LogEvent) => void>();
    const { agent, calls } = agentAnswering({ set_preferences: reply({ preferences: stored, changes }) });
    const saved = await savePreferences(agent, { comfortC: { cooling: 24 } }, ctx, log);
    expect(saved).toMatchObject({ ok: true, value: { preferences: { comfortC: { cooling: 24 } } } });
    expect(calls).toEqual([['set_preferences', { comfortC: { cooling: 24 }, confirmed: true }]]);
    expect(log).toHaveBeenCalledWith({ level: 'info', code: 'preferences_changed', correlationId: 'corr-402', details: { fields: ['comfortC.cooling'] } });
  });

  it('a refusal keeps its own code (the daily limit says so), is never shown as saved and is logged with the correlation id', async () => {
    const log = vi.fn<(e: LogEvent) => void>();
    const limited = agentAnswering({ set_preferences: reply(toolError('demo_quota_exceeded', 'The demo is used up for today.'), true) });
    expect(await savePreferences(limited.agent, { comfortC: { cooling: 24 } }, ctx, log)).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded' } });
    const odd = agentAnswering({ set_preferences: reply({ nope: 1 }) });
    expect(await savePreferences(odd.agent, { comfortC: { cooling: 24 } }, ctx, log)).toMatchObject({ ok: false, error: { code: 'output_schema_violation' } });
    const broken = agentAnswering({ set_preferences: new Error('network') });
    expect(await savePreferences(broken.agent, { comfortC: { cooling: 24 } }, ctx, log)).toMatchObject({ ok: false, error: { code: 'agent_unavailable' } });
    expect(log.mock.calls.every(([e]) => e.level === 'warn' && e.correlationId === 'corr-402')).toBe(true);
    expect(log).toHaveBeenCalledTimes(3);
  });
});
