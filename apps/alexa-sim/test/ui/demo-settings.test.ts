import { setLocale } from '@cold-reserve/i18n';
import { describe, expect, it } from 'vitest';
import type { Agent } from '../../src/agent/agent.js';
import { applyChange, badgeText, fetchDemoSettings, saveDemoSettings, scriptedDemoSettings, skyOfScenario } from '../../src/ui/demo-settings.js';

// B1 (additions plan): what the scenario badge says and how a choice changes the settings shown, in scripted mode.

describe('demo settings', () => {
  it('starts on the heat-wave day at the reference home, in °C, with an older man at home', () => {
    expect(scriptedDemoSettings()).toEqual({ scenarioId: 'heatwave', locationId: 'reference', units: 'C', household: 'older-man' });
  });

  it('#284: the badge names the place in the page language at render time, not in the language it was read in', () => {
    setLocale('it-IT');
    try {
      expect(badgeText(scriptedDemoSettings())).toBe('SCENARIO · Casa di riferimento (Italia centrale) · Ondata di calore');
    } finally {
      setLocale('en-US');
    }
  });

  it('the badge names the place and the scenario; in the storm it says the power is out', () => {
    expect(badgeText(scriptedDemoSettings())).toBe('SCENARIO · Reference home (central Italy) · Heat wave');
    expect(badgeText({ ...scriptedDemoSettings(), scenarioId: 'storm-blackout' })).toBe('SCENARIO · Reference home (central Italy) · Storm · power outage');
  });

  it('a choice changes only what was chosen; a restart changes nothing but the day', () => {
    const before = scriptedDemoSettings();
    expect(applyChange(before, { units: 'F' })).toEqual({ ...before, units: 'F' });
    expect(applyChange(before, { restart: true })).toEqual(before);
  });

  it('each scenario has its sky', () => {
    expect(skyOfScenario('clear-day')).toBe('mild');
    expect(skyOfScenario('heatwave')).toBe('hot');
    expect(skyOfScenario('storm-blackout')).toBe('storm');
  });
});

describe('remote demo settings (B2): read and saved through the card tool route', () => {
  const ctx = { correlationId: 'c1' };
  const settings = { version: 3, updatedAt: '2026-10-05T10:00:00Z', scenarioId: 'heatwave', locationId: 'reference', units: 'C', household: 'older-man' } as const;
  const place = { id: 'reference', label: 'Reference home (central Italy)', tz: 'Europe/Rome' } as const;
  const reply = (structuredContent: unknown, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: 'x' }], structuredContent });
  const agentAnswering = (answers: Record<string, unknown>) => {
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

  it('reads the sandbox settings; the place is named at render time, never kept from the server\'s label (#284)', async () => {
    const { agent } = agentAnswering({ get_demo_settings: reply({ settings, place }) });
    expect(await fetchDemoSettings(agent, ctx)).toEqual({ ok: true, value: { scenarioId: 'heatwave', locationId: 'reference', units: 'C', household: 'older-man' } });
  });

  it('a home that is not a sandbox (a tool error) has no settings to show', async () => {
    const { agent } = agentAnswering({ get_demo_settings: reply({ code: 'invalid_input' }, true) });
    expect(await fetchDemoSettings(agent, ctx)).toMatchObject({ ok: false });
  });

  it('saves one change, then reads the settings back, so the badge shows what is stored', async () => {
    const stored = { ...settings, version: 4, scenarioId: 'storm-blackout' as const };
    const { agent, calls } = agentAnswering({ set_scenario: reply({ settings: stored, restarted: true }), get_demo_settings: reply({ settings: stored, place }) });
    expect(await saveDemoSettings(agent, { scenarioId: 'storm-blackout' }, ctx)).toMatchObject({ ok: true, value: { scenarioId: 'storm-blackout' } });
    expect(calls).toEqual([
      ['set_scenario', { scenarioId: 'storm-blackout' }],
      ['get_demo_settings', {}],
    ]);
  });

  it('a refused or failed save is never shown as saved', async () => {
    const { agent } = agentAnswering({ set_scenario: reply({ code: 'invalid_input' }, true) });
    expect(await saveDemoSettings(agent, { locationId: 'houston' }, ctx)).toMatchObject({ ok: false });
    const broken = agentAnswering({ set_scenario: new Error('network') });
    expect(await saveDemoSettings(broken.agent, { units: 'F' }, ctx)).toMatchObject({ ok: false });
  });
});
