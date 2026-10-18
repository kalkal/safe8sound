// @vitest-environment jsdom
import { toolError, type ErrorCode, type GetPreferencesOutput, type ReserveOutlook } from '@cold-reserve/contracts';
import { getLocale, setLocale } from '@cold-reserve/i18n';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, ToolCallResult } from '../../src/agent/agent.js';
import { SCRIPT_FIXTURES } from '../../src/agent/script-fixtures.js';
import { createScriptedClock } from '../../src/agent/scripted-clock.js';
import { createScriptedPhone } from '../../src/phone/phone-feed.js';
import { useDemoSettings } from '../../src/state/use-demo-settings.js';
import { useLocaleSetting } from '../../src/state/use-locale-setting.js';
import { usePreferences } from '../../src/state/use-preferences.js';
import { useReserve } from '../../src/state/use-reserve.js';
import { useSimClock } from '../../src/state/use-sim-clock.js';
import { fakeAgent, held, reply } from './fake-agent.js';

// The page's state, out of the root component (separation of the device layout, step S1): each hook owns one kind of
// data and how it is read and saved, so any layout (the Echo, a phone, a plain page) uses the same state. The rules of
// each read and save are tested with their functions (demo-settings, preferences-settings, reserve, sim-clock); here
// only the wiring: when a hook reads, what a save changes, and that a failure leaves the last good state.

afterEach(() => {
  cleanup();
  setLocale('en-US');
});

const preferencesCard = SCRIPT_FIXTURES.preferences();
if (preferencesCard.tool !== 'get_preferences') throw new Error('fixture');
const preferences: GetPreferencesOutput = preferencesCard.result;
const reserveCard = SCRIPT_FIXTURES['reserve-outlook']();
if (reserveCard.tool !== 'get_reserve_outlook') throw new Error('fixture');
const outlook: ReserveOutlook = reserveCard.result;
const settings = { version: 3, updatedAt: '2026-10-05T10:00:00Z', scenarioId: 'heatwave', locationId: 'reference', units: 'C', household: 'older-man' } as const;
const place = { id: 'reference', label: 'Reference home', tz: 'Europe/Rome' } as const;
const refused = (code: ErrorCode): ToolCallResult => reply(toolError(code, 'Refused.'), true);

describe('useLocaleSetting', () => {
  it('a choice changes the page language, its lang and title, and is kept on this browser', () => {
    const { result } = renderHook(() => useLocaleSetting());
    expect(result.current.locale).toBe('en-US');
    act(() => {
      result.current.chooseLocale('it-IT');
    });
    expect(result.current.locale).toBe('it-IT');
    expect(getLocale()).toBe('it-IT');
    expect(document.documentElement.lang).toBe('it');
    expect(document.title).toContain('Safe-8-Sound');
    expect(globalThis.localStorage.getItem('cold-reserve.locale')).toBe('it-IT');
  });
});

describe('useDemoSettings', () => {
  it('scripted: starts on the scripted settings, plays a change on the scripted home and starts a new day', async () => {
    const { agent, calls } = fakeAgent({ set_scenario: reply({}) });
    const onScenario = vi.fn();
    const onNewPlay = vi.fn();
    const { result } = renderHook(() => useDemoSettings({ agent, scripted: true, sessionToken: undefined, onScenario, onNewPlay }));
    expect(result.current.settings?.scenarioId).toBe('heatwave');
    let saved = false;
    await act(async () => {
      saved = await result.current.change({ scenarioId: 'storm-blackout' });
    });
    expect(saved).toBe(true);
    expect(result.current.settings?.scenarioId).toBe('storm-blackout');
    expect(calls).toEqual([['set_scenario', { scenarioId: 'storm-blackout' }]]);
    expect(onScenario).toHaveBeenCalledWith('storm-blackout');
    expect(result.current.playthrough).toBe(1);
    // The scripted home has nothing to read again.
    expect(onNewPlay).not.toHaveBeenCalled();
  });

  it('remote: reads the sandbox once the session starts; a saved change shows what is stored and reads the home again', async () => {
    const stored = { ...settings, scenarioId: 'storm-blackout' } as const;
    const fake = fakeAgent({ get_demo_settings: reply({ settings, place }) });
    const onScenario = vi.fn();
    const onNewPlay = vi.fn();
    const { result, rerender } = renderHook(({ token }) => useDemoSettings({ agent: fake.agent, scripted: false, sessionToken: token, onScenario, onNewPlay }), {
      initialProps: { token: undefined as string | undefined },
    });
    expect(result.current.settings).toBeUndefined();
    expect(fake.calls).toEqual([]);
    rerender({ token: 'tok' });
    await waitFor(() => {
      expect(result.current.settings?.scenarioId).toBe('heatwave');
    });
    fake.answers['set_scenario'] = reply({ settings: stored, restarted: true });
    fake.answers['get_demo_settings'] = reply({ settings: stored, place });
    await act(async () => {
      expect(await result.current.change({ scenarioId: 'storm-blackout' })).toBe(true);
    });
    expect(result.current.settings?.scenarioId).toBe('storm-blackout');
    expect(onScenario).toHaveBeenCalledWith('storm-blackout');
    expect(onNewPlay).toHaveBeenCalledTimes(1);
    expect(result.current.playthrough).toBe(1);
  });

  it('remote: a refused or failed save keeps the settings shown and starts no new day', async () => {
    const fake = fakeAgent({ get_demo_settings: reply({ settings, place }), set_scenario: refused('invalid_input') });
    const onNewPlay = vi.fn();
    const { result } = renderHook(() => useDemoSettings({ agent: fake.agent, scripted: false, sessionToken: 'tok', onNewPlay }));
    await waitFor(() => {
      expect(result.current.settings?.scenarioId).toBe('heatwave');
    });
    for (const answer of [refused('invalid_input'), new Error('network down')]) {
      fake.answers['set_scenario'] = answer;
      await act(async () => {
        expect(await result.current.change({ restart: true })).toBe(false);
      });
    }
    expect(result.current.settings?.scenarioId).toBe('heatwave');
    expect(result.current.playthrough).toBe(0);
    expect(onNewPlay).not.toHaveBeenCalled();
  });
});

describe('usePreferences', () => {
  it('reads only when it may, again when its key changes, and a saved limit shows what the tool stored', async () => {
    const fake = fakeAgent({ get_preferences: reply(preferences) });
    const { result, rerender } = renderHook(({ enabled, key }) => usePreferences({ agent: fake.agent, enabled, key }), { initialProps: { enabled: false, key: 'a' } });
    expect(fake.count('get_preferences')).toBe(0);
    rerender({ enabled: true, key: 'a' });
    await waitFor(() => {
      expect(result.current.limits).toEqual(preferences);
    });
    rerender({ enabled: true, key: 'b' });
    await waitFor(() => {
      expect(fake.count('get_preferences')).toBe(2);
    });
    const cooling = (preferences.preferences.comfortC.cooling as number) - 1;
    fake.answers['set_preferences'] = reply({ preferences: { ...preferences.preferences, comfortC: { ...preferences.preferences.comfortC, cooling } }, changes: [] });
    await act(async () => {
      expect(await result.current.saveLimit({ comfortC: { cooling: cooling } })).toBe('saved');
    });
    expect(result.current.limits?.preferences.comfortC.cooling).toBe(cooling);
    // No read back: the stored value came with the save.
    expect(fake.count('get_preferences')).toBe(2);
  });

  it('a rate limit says so, any other failure says failed, and the shown limits stay', async () => {
    const fake = fakeAgent({ get_preferences: reply(preferences), set_preferences: refused('demo_quota_exceeded') });
    const { result } = renderHook(() => usePreferences({ agent: fake.agent, enabled: true, key: 'a' }));
    await waitFor(() => {
      expect(result.current.limits).toEqual(preferences);
    });
    await act(async () => {
      expect(await result.current.saveLimit({ comfortC: { cooling: 25 } })).toBe('rate_limited');
    });
    fake.answers['set_preferences'] = new Error('network down');
    await act(async () => {
      expect(await result.current.saveLimit({ comfortC: { cooling: 25 } })).toBe('failed');
    });
    expect(result.current.limits).toEqual(preferences);
  });

  it('a read that ends after the key changed is dropped', async () => {
    const slow = held(reply(preferences));
    const fake = fakeAgent({ get_preferences: slow.answer });
    const { result, rerender } = renderHook(({ key }) => usePreferences({ agent: fake.agent, enabled: true, key }), { initialProps: { key: 'a' } });
    fake.answers['get_preferences'] = refused('invalid_input');
    rerender({ key: 'b' });
    await act(async () => {
      slow.release();
      await Promise.resolve();
    });
    expect(result.current.limits).toBeUndefined();
  });
});

describe('useReserve', () => {
  it('reads when it may and again on each change it follows; the old hours go first', async () => {
    const slow = held(reply(outlook));
    const fake = fakeAgent({ get_reserve_outlook: slow.answer });
    const { result, rerender } = renderHook(({ enabled, now }) => useReserve({ agent: fake.agent, enabled, scenarioId: 'heatwave', gridDown: false, now }), {
      initialProps: { enabled: false, now: '12:00' },
    });
    expect(fake.count('get_reserve_outlook')).toBe(0);
    rerender({ enabled: true, now: '12:00' });
    await act(async () => {
      slow.release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current).toEqual(outlook);
    });
    fake.answers['get_reserve_outlook'] = refused('invalid_input');
    rerender({ enabled: true, now: '15:00' });
    expect(result.current).toBeUndefined();
    await waitFor(() => {
      expect(fake.count('get_reserve_outlook')).toBe(2);
    });
    expect(result.current).toBeUndefined();
  });
});

describe('useSimClock', () => {
  /** An agent whose tool calls the scripted clock answers, as the sandbox would. */
  function sandbox() {
    const phone = createScriptedPhone();
    const clock = createScriptedClock({ phone, startScenario: 'storm-blackout' });
    const agent = {
      canCallTools: true,
      ask: () => Promise.reject(new Error('unused')),
      callTool: (name: string, args: Record<string, unknown>) => Promise.resolve(clock.call(name, args) ?? refused('invalid_input')),
    } satisfies Agent;
    return agent;
  }
  const base = { scenario: 'storm-blackout' as const, planId: undefined, playthrough: 0 };

  it('reads the clock only for a sandbox; a skip moves it, names the moment reached and reads what follows', async () => {
    const agent = sandbox();
    const afterMove = vi.fn();
    const { result, rerender } = renderHook(({ enabled }) => useSimClock({ agent, enabled, afterMove, ...base }), { initialProps: { enabled: false } });
    expect(result.current.clock).toBeUndefined();
    rerender({ enabled: true });
    await waitFor(() => {
      expect(result.current.clock?.next).toBeDefined();
    });
    const before = result.current.clock;
    act(() => {
      result.current.skip();
    });
    expect(result.current.busy).toBe(true);
    await waitFor(() => {
      expect(result.current.busy).toBe(false);
    });
    expect(result.current.clock?.now).not.toBe(before?.now);
    expect(result.current.note).toEqual({ kind: 'reached', moment: before?.next?.kind });
    expect(afterMove).toHaveBeenCalledTimes(1);
    act(() => {
      result.current.clearNote();
    });
    expect(result.current.note).toBeUndefined();
  });

  it('a read started before a skip never draws over the clock the skip left', async () => {
    const real = sandbox();
    let first: ReturnType<typeof held> | undefined;
    const agent = {
      ...real,
      callTool: async (name: string, args: Record<string, unknown>) => {
        const answer = await real.callTool(name, args);
        if (name !== 'get_milestones' || first !== undefined) return answer;
        first = held(answer);
        return first.answer();
      },
    } satisfies Agent;
    const { result } = renderHook(() => useSimClock({ agent, enabled: true, afterMove: vi.fn(), ...base }));
    await waitFor(() => {
      expect(first).toBeDefined();
    });
    act(() => {
      result.current.skip();
    });
    await waitFor(() => {
      expect(result.current.note?.kind).toBe('reached');
    });
    const moved = result.current.clock;
    await act(async () => {
      first?.release();
      await Promise.resolve();
    });
    expect(result.current.clock).toEqual(moved);
  });

  it('a skip refused by the daily limit says limit; any other failure says failed; nothing else moves', async () => {
    const afterMove = vi.fn();
    for (const [answer, kind] of [
      [refused('demo_quota_exceeded'), 'limit'],
      [new Error('network down'), 'failed'],
    ] as const) {
      const { agent } = fakeAgent({ get_milestones: answer });
      const { result } = renderHook(() => useSimClock({ agent, enabled: true, afterMove, ...base }));
      act(() => {
        result.current.skip();
      });
      await waitFor(() => {
        expect(result.current.note).toEqual({ kind });
      });
      expect(result.current.busy).toBe(false);
      cleanup();
    }
    expect(afterMove).not.toHaveBeenCalled();
  });

  it('a power cut takes the clock to the grid going down and reads what follows; a failure is returned as a value', async () => {
    const agent = sandbox();
    const afterMove = vi.fn();
    const { result } = renderHook(() => useSimClock({ agent, enabled: true, afterMove, ...base }));
    await waitFor(() => {
      expect(result.current.clock).toBeDefined();
    });
    const saveStorm = vi.fn(() => Promise.resolve(true));
    let cut: Awaited<ReturnType<typeof result.current.cutPower>> | undefined;
    await act(async () => {
      cut = await result.current.cutPower({ stormScenario: true, familyTold: false, saveStorm }, { correlationId: 'c' });
    });
    expect(cut?.ok).toBe(true);
    expect(result.current.note).toEqual({ kind: 'grid_down' });
    expect(result.current.clock?.next?.kind).not.toBe('storm_start');
    expect(afterMove).toHaveBeenCalledTimes(1);

    const broken = fakeAgent({ get_milestones: new Error('network down') });
    const nothingFollows = vi.fn();
    const failing = renderHook(() => useSimClock({ agent: broken.agent, enabled: false, afterMove: nothingFollows, ...base }));
    await act(async () => {
      cut = await failing.result.current.cutPower({ stormScenario: true, familyTold: false, saveStorm }, { correlationId: 'c' });
    });
    expect(cut?.ok).toBe(false);
    expect(failing.result.current.clock).toBeUndefined();
    expect(nothingFollows).not.toHaveBeenCalled();
  });
});
