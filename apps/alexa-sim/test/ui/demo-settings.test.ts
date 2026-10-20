import { setLocale } from '@cold-reserve/i18n';
import { describe, expect, it } from 'vitest';
import type { Agent } from '../../src/agent/agent.js';
import { toolError } from '@cold-reserve/contracts';
import { toolErrorResult } from '../../src/agent/agent.js';
import type { LogEvent } from '../../src/log.js';
import { HOUSEHOLDS, applyChange, homeFaceOf, badgeText, closedNoticeOf, fetchDemoSettings, readDemoSettings, saveDemoSettings, scriptedDemoSettings, skyOfScenario } from '../../src/ui/demo-settings.js';

// B1 (additions plan): what the scenario badge says and how a choice changes the settings shown, in scripted mode.

describe('demo settings', () => {
  it('starts on the heat-wave day at the reference home, in °C, with an older man at home', () => {
    expect(scriptedDemoSettings()).toEqual({ scenarioId: 'heatwave', locationId: 'reference', units: 'C', household: 'older-man' });
  });

  it('#284: the badge names the place in the page language at render time, not in the language it was read in', () => {
    setLocale('it-IT');
    try {
      expect(badgeText(scriptedDemoSettings())).toBe('SCENARIO · Casa di riferimento (Italia) · Ondata di calore');
    } finally {
      setLocale('en-US');
    }
  });

  it('the badge names the place and the scenario; in the storm it says the power is out', () => {
    expect(badgeText(scriptedDemoSettings())).toBe('SCENARIO · Reference home (Italy) · Heat wave');
    expect(badgeText({ ...scriptedDemoSettings(), scenarioId: 'storm-blackout' })).toBe('SCENARIO · Reference home (Italy) · Storm · power outage');
  });

  it('a choice changes only what was chosen; a restart changes nothing but the day', () => {
    const before = scriptedDemoSettings();
    expect(applyChange(before, { units: 'F' })).toEqual({ ...before, units: 'F' });
    expect(applyChange(before, { restart: true })).toEqual(before);
  });

  it('°F everywhere (owner decision, 9 Oct): a new place starts in its own unit; a unit chosen with it, or later, wins', () => {
    const before = scriptedDemoSettings();
    expect(applyChange(before, { locationId: 'houston' })).toMatchObject({ locationId: 'houston', units: 'F' });
    expect(applyChange(before, { locationId: 'houston', units: 'C' })).toMatchObject({ locationId: 'houston', units: 'C' });
    const houston = applyChange(before, { locationId: 'houston' });
    expect(applyChange(houston, { units: 'C' })).toMatchObject({ locationId: 'houston', units: 'C' });
    expect(applyChange(houston, { locationId: 'turin' })).toMatchObject({ locationId: 'turin', units: 'C' });
    // Another choice keeps the unit: only a new place resets it.
    expect(applyChange({ ...houston, units: 'C' }, { scenarioId: 'storm-blackout' })).toMatchObject({ units: 'C' });
  });

  it("a new place drops the old place's time zone (never Houston's times on Turin's clock); other choices keep it", () => {
    const chicago = { ...scriptedDemoSettings(), locationId: 'houston' as const, timeZone: 'America/Chicago' };
    expect(applyChange(chicago, { locationId: 'turin' })).not.toHaveProperty('timeZone');
    expect(applyChange(chicago, { scenarioId: 'storm-blackout' })).toMatchObject({ timeZone: 'America/Chicago' });
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
  const place = { id: 'reference', label: 'Reference home (Italy)', tz: 'Europe/Rome' } as const;
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
    expect(await fetchDemoSettings(agent, ctx)).toEqual({ ok: true, value: { scenarioId: 'heatwave', locationId: 'reference', units: 'C', household: 'older-man', timeZone: 'Europe/Rome' } });
  });

  it('a sandbox that saved "A frail person" (older-woman, no longer offered, 20 Oct) shows as "An older man"', async () => {
    const { agent } = agentAnswering({ get_demo_settings: reply({ settings: { ...settings, household: 'older-woman' }, place }) });
    expect(await fetchDemoSettings(agent, ctx)).toMatchObject({ ok: true, value: { household: 'older-man' } });
  });

  it("every time on screen is on the sandbox place's clock (Houston: America/Chicago), whatever the browser's zone", async () => {
    const houston = { ...settings, locationId: 'houston' as const, units: 'F' as const };
    const { agent } = agentAnswering({ get_demo_settings: reply({ settings: houston, place: { id: 'houston', label: 'Houston', tz: 'America/Chicago' } }) });
    expect(await fetchDemoSettings(agent, ctx)).toMatchObject({ ok: true, value: { locationId: 'houston', timeZone: 'America/Chicago' } });
  });

  it('a zone this browser does not know is left out: the page keeps its configured home zone', async () => {
    const { agent } = agentAnswering({ get_demo_settings: reply({ settings, place: { ...place, tz: 'Mars/Olympus' } }) });
    const read = await fetchDemoSettings(agent, ctx);
    expect(read).toMatchObject({ ok: true, value: { locationId: 'reference' } });
    expect(read.ok ? read.value : undefined).not.toHaveProperty('timeZone');
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

describe('who is at home (owner, 20 Oct)', () => {
  it('offers an older man and no one at risk, never "A frail person"', () => {
    expect(HOUSEHOLDS).toEqual(['older-man', 'no-one-at-risk']);
  });

  it("the home's face and its line: the small house and 'no one at risk' with no one at risk, Leo for a man, a saved older-woman and before the settings are read", () => {
    const leo = { avatar: 'older-man', who: 'settings.protect.leo', named: true };
    expect([homeFaceOf('older-man'), homeFaceOf('no-one-at-risk'), homeFaceOf('older-woman'), homeFaceOf(undefined)]).toEqual([leo, { avatar: 'home', who: 'settings.protect.noOne', named: false }, leo, leo]);
  });
});
// Test's judge run on the dev site (20 Oct, 375 × 812): the first read of the sandbox settings after Start failed and
// was never tried again, so the demo controls, the clock and the place never came until F5. A failure that may pass
// (the catalog's retryable codes) is tried again a few times, with the wait the server asks for; one that will not
// pass (a home that is not a sandbox) is not. Every try and the last failure are logged with the correlation id.
describe('reading the sandbox settings after Start', () => {
  const ctx = { correlationId: 'c1' };
  const settings = { version: 3, updatedAt: '2026-10-05T10:00:00Z', scenarioId: 'heatwave', locationId: 'reference', units: 'C', household: 'older-man' } as const;
  const place = { id: 'reference', label: 'Reference home (Italy)', tz: 'Europe/Rome' } as const;
  const good = { content: [{ type: 'text', text: 'x' }], structuredContent: { settings, place } };
  const busy = toolErrorResult(toolError('agent_unavailable', 'The assistant service failed (HTTP 503).'));
  const slowDown = toolErrorResult(toolError('turn_in_progress', 'One moment.', { retryAfterMs: 4000 }));
  const longWait = toolErrorResult(toolError('turn_in_progress', 'One moment.', { retryAfterMs: 30_000 }));
  const notSandbox = toolErrorResult(toolError('invalid_input', 'No settings.'));
  const agentReplying = (...replies: unknown[]) => {
    let calls = 0;
    const agent = {
      canCallTools: true,
      ask: () => Promise.reject(new Error('unused')),
      callTool: () => Promise.resolve(replies[Math.min(calls++, replies.length - 1)]),
    } as unknown as Agent;
    return { agent, calls: () => calls };
  };
  const recorder = () => {
    const waits: number[] = [];
    const logs: LogEvent[] = [];
    return { waits, logs, wait: (ms: number) => (waits.push(ms), Promise.resolve()), log: (e: LogEvent) => logs.push(e) };
  };

  it('keeps the reason of a failed read: a busy service is worth another try, a home that is not a sandbox is not', async () => {
    expect(await fetchDemoSettings(agentReplying(busy).agent, ctx, () => undefined)).toMatchObject({ ok: false, error: { code: 'agent_unavailable', retryable: true } });
    expect(await fetchDemoSettings(agentReplying(notSandbox).agent, ctx, () => undefined)).toMatchObject({ ok: false, error: { retryable: false } });
  });

  it('a read that fails once and then answers shows the settings', async () => {
    const { agent, calls } = agentReplying(busy, good);
    const r = recorder();
    expect(await readDemoSettings(agent, ctx, { wait: r.wait, logEvent: r.log })).toMatchObject({ ok: true, value: { locationId: 'reference' } });
    expect(calls()).toBe(2);
    expect(r.waits).toHaveLength(1);
  });

  it('waits as long as the server asks before trying again', async () => {
    const r = recorder();
    await readDemoSettings(agentReplying(slowDown, good).agent, ctx, { wait: r.wait, logEvent: r.log });
    expect(r.waits).toEqual([4000]);
  });

  it('never waits long on the first screen: a retryable failure asking for more than 10 s is not tried again', async () => {
    const { agent, calls } = agentReplying(longWait, good);
    const r = recorder();
    expect(await readDemoSettings(agent, ctx, { wait: r.wait, logEvent: r.log })).toMatchObject({ ok: false, error: { code: 'turn_in_progress' } });
    expect(calls()).toBe(1);
    expect(r.waits).toEqual([]);
  });

  it("the day's turns used up (HTTP 429) are never tried again, even with a short wait", async () => {
    const soon = toolErrorResult(toolError('demo_quota_exceeded', 'The demo is full for today.', { retryAfterMs: 2000 }));
    const { agent, calls } = agentReplying(soon, good);
    const r = recorder();
    expect(await readDemoSettings(agent, ctx, { wait: r.wait, logEvent: r.log })).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded', retryAfterMs: 2000 } });
    expect(calls()).toBe(1);
    expect(r.waits).toEqual([]);
  });

  it('never tries again what will not pass', async () => {
    const { agent, calls } = agentReplying(notSandbox, good);
    const r = recorder();
    expect(await readDemoSettings(agent, ctx, { wait: r.wait, logEvent: r.log })).toMatchObject({ ok: false });
    expect(calls()).toBe(1);
    expect(r.waits).toEqual([]);
  });

  it('gives up after three tries, says so in the log with the correlation id, and never loops', async () => {
    const { agent, calls } = agentReplying(busy);
    const r = recorder();
    expect(await readDemoSettings(agent, ctx, { wait: r.wait, logEvent: r.log })).toMatchObject({ ok: false, error: { code: 'agent_unavailable' } });
    expect(calls()).toBe(3);
    expect(r.waits).toHaveLength(2);
    expect(r.logs.at(-1)).toMatchObject({ level: 'warn', code: 'agent_unavailable', correlationId: 'c1', details: { step: 'get_demo_settings', tries: 3 } });
  });

  it('stops when the page no longer wants the answer (a new session, the page closed)', async () => {
    const { agent, calls } = agentReplying(busy, good);
    const r = recorder();
    const read = await readDemoSettings(agent, ctx, { wait: r.wait, logEvent: r.log, wanted: () => false });
    expect(read).toMatchObject({ ok: false });
    expect(calls()).toBe(1);
  });
});

// The day's turns used up (Test's dev-site run, 20 Oct: every read after Start was HTTP 429): the screen says the
// server's own words once, with the time the demo comes back on the visitor's own clock, in 24 h (main, 20 Oct).
describe('the demo closed for today', () => {
  const full = (retryAfterMs?: number) => toolError('demo_quota_exceeded', 'The demo is full for today.', retryAfterMs === undefined ? {} : { retryAfterMs });
  const lateEvening = new Date(2026, 9, 20, 23, 30).getTime();

  it("says the demo is full for today and when it comes back, on the visitor's clock, in the page's language", () => {
    expect(closedNoticeOf(full(150 * 60_000), lateEvening)).toBe('The demo limit for today is reached. Back at 02:00 (your time).');
    setLocale('it-IT');
    expect(closedNoticeOf(full(150 * 60_000), lateEvening)).toBe('Il limite della demo per oggi è stato raggiunto. Di nuovo disponibile alle 02:00 (ora tua).');
    setLocale('en-US');
  });

  it('says only that the demo is full when the server gives no time', () => {
    expect(closedNoticeOf(full(), lateEvening)).toBe('The demo limit for today is reached.');
  });

  it('says nothing for any other failure (the page keeps its usual messages)', () => {
    expect(closedNoticeOf(toolError('agent_unavailable', 'Down.'), lateEvening)).toBeUndefined();
    expect(closedNoticeOf(toolError('invalid_input', 'No settings.'), lateEvening)).toBeUndefined();
  });
});
