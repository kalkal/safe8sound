import { CARD_TOOL_ACCESS, PreferencesSchema, SafetyHardLimitsSchema, type HomeId } from '@cold-reserve/contracts';
import { examplePreferences, exampleSafetyLimits } from '@cold-reserve/contracts/fixtures';
import type { StateStore } from '@cold-reserve/core';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { describe, expect, it } from 'vitest';
import { preferencesModule, type PreferencesModuleDeps } from '../src/modules/preferences.js';
import { HOME_TOKEN, callTool, initializeRequest, makeHandler, post, toolResult, toolsList } from './helpers.js';

const NOW_MS = Date.parse('2026-07-15T12:00:00Z');

function deps(overrides: Partial<PreferencesModuleDeps> = {}): PreferencesModuleDeps {
  return {
    storeFor: memoryStateStoreFactory({ backing: createMemoryBacking(), clock: { now: () => NOW_MS } }),
    limits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()),
    roomIdsFor: () => ['bedroom-1', 'living', 'study'],
    defaultsFor: () => PreferencesSchema.parse(examplePreferences()),
    clock: { now: () => NOW_MS },
    ...overrides,
  };
}

async function call(d: PreferencesModuleDeps, name: string, args: unknown, token?: string) {
  const { handler } = makeHandler({ modules: [preferencesModule(d)] });
  const headers = token === undefined ? {} : { authorization: `Bearer ${token}` };
  await post(handler, initializeRequest, headers);
  return toolResult(await post(handler, callTool(name, args), headers));
}

describe('preferences module (MCP tools)', () => {
  it('lists get_preferences (read-only) and set_preferences (destructive: it overwrites safety thresholds)', async () => {
    const { handler } = makeHandler({ modules: [preferencesModule(deps())] });
    const res = await post(handler, toolsList);
    const body = (await res.json()) as { result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> } };
    const byName = Object.fromEntries(body.result.tools.map((t) => [t.name, t.annotations]));
    expect(byName['get_preferences']).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(byName['set_preferences']).toMatchObject({ readOnlyHint: CARD_TOOL_ACCESS.set_preferences === 'read', destructiveHint: true, idempotentHint: true });
  });

  it('names the safe room in the text, never its id (#192)', async () => {
    const named = deps({ roomNameFor: (_home, id) => ({ 'bedroom-1': 'Bedroom' })[id] });
    const result = await call(named, 'get_preferences', {});
    const text = (result.content as { text: string }[])[0]?.text;
    expect(text).toContain('safe room Bedroom.');
    expect((text ?? '').slice(0, (text ?? '').indexOf(' Room ids for tools'))).not.toContain('bedroom-1');
  });

  it('returns the defaults for a home with nothing saved, with the hard limits', async () => {
    const result = await call(deps(), 'get_preferences', {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      isDefault: true,
      preferences: { safeRoomId: 'bedroom-1', safety: { cooling: { maxC: 27 } } },
      hardLimits: { cooling: { maxC: { min: 24, max: 30 } } },
    });
  });

  it('never gives contact names or handles to the model: roles only', async () => {
    const result = await call(deps(), 'get_preferences', {});
    expect(result.structuredContent).toMatchObject({ preferences: { contacts: [{ role: 'daughter', channel: 'in_app' }] } });
    expect(JSON.stringify(result)).not.toMatch(/Example Contact|phone-1/);
  });

  it('get_preferences gives the room ids in a separate "do not say" line; set_preferences says rooms by name (#192)', async () => {
    const names: Record<string, string> = { 'bedroom-1': 'Bedroom', living: 'Living room', study: 'Study' };
    const d = deps({ roomNameFor: (_home, id) => names[id] });
    const text = ((await call(d, 'get_preferences', {})).content as { text: string }[])[0]?.text ?? '';
    expect(text).toContain(' Room ids for tools (do not say them): Bedroom = bedroom-1; Living room = living; Study = study.');
    expect(text.slice(0, text.indexOf(' Room ids for tools'))).not.toMatch(/bedroom-1|living\b|study\b/);
    const set = await call(d, 'set_preferences', { safeRoomId: 'living', roomPriority: ['living', 'bedroom-1'], confirmed: true });
    const said = (set.content as { text: string }[])[0]?.text ?? '';
    expect(said).toContain('safe room from Bedroom to Living room');
    expect(said).toContain('room priority from');
    expect(said).not.toMatch(/bedroom-1|\bliving\b(?!\s+room)/);
    const refused = await call(d, 'set_preferences', { safeRoomId: 'attic', confirmed: true });
    expect((refused.content as { text: string }[])[0]?.text ?? '').toContain('The rooms are: Bedroom (bedroom-1), Living room (living), Study (study).');
  });

  it('saves a confirmed change and reports it; the next read is no longer the default', async () => {
    const d = deps();
    const set = await call(d, 'set_preferences', { safety: { cooling: { maxC: 28 } }, confirmed: true });
    expect(set.isError).toBeFalsy();
    expect(set.structuredContent).toMatchObject({
      preferences: { safety: { cooling: { maxC: 28 } } },
      changes: [{ field: 'safety.cooling.maxC', from: 27, to: 28, by: 'user', confirmed: true, confirmedVia: 'tool', ts: '2026-07-15T12:00:00.000Z' }],
    });
    expect((await call(d, 'get_preferences', {})).structuredContent).toMatchObject({ isDefault: false, preferences: { safety: { cooling: { maxC: 28 } } } });
  });

  it('stamps a change at the home own scenario time when the home has a clock (C2b, review of #225)', async () => {
    const homeMs = Date.parse('2026-07-17T09:30:00Z');
    const set = await call(deps({ clockFor: () => ({ now: () => homeMs }) }), 'set_preferences', { safety: { cooling: { maxC: 28 } }, confirmed: true });
    expect(set.structuredContent).toMatchObject({ changes: [{ ts: '2026-07-17T09:30:00.000Z' }] });
    // A home without its own clock keeps the module clock.
    const plain = await call(deps({ clockFor: () => undefined }), 'set_preferences', { safety: { cooling: { maxC: 28 } }, confirmed: true });
    expect(plain.structuredContent).toMatchObject({ changes: [{ ts: '2026-07-15T12:00:00.000Z' }] });
  });

  it('reports every refusal of the domain through MCP, and saves nothing', async () => {
    const d = deps();
    expect(await call(d, 'set_preferences', { comfortC: { cooling: 29 }, confirmed: true })).toMatchObject({
      isError: true,
      structuredContent: { code: 'invalid_setpoint', details: { field: 'comfortC.cooling', nearestAllowed: 27 } },
    });
    expect(await call(d, 'set_preferences', { roomPriority: ['living', 'bedroom-1', 'study'], confirmed: true })).toMatchObject({
      isError: true,
      structuredContent: { code: 'invalid_input', details: { field: 'roomPriority' } },
    });
    expect((await call(d, 'get_preferences', {})).structuredContent).toMatchObject({ isDefault: true });
  });

  it('reports a failed write as store_unavailable and does not claim the change', async () => {
    const memory = memoryStateStoreFactory({ backing: createMemoryBacking(), clock: { now: () => NOW_MS } });
    // Reads go to a real memory store; the write fails.
    const storeFor = (home: HomeId): StateStore => {
      const base = memory(home);
      return {
        homeId: base.homeId,
        getPreferences: () => base.getPreferences(),
        putPreferences: () => Promise.resolve({ ok: false, error: { code: 'store_unavailable', category: 'dependency_unavailable', message: 'Down.', retryable: true } }),
        listConfigChanges: () => base.listConfigChanges(),
        savePlan: (plan) => base.savePlan(plan),
        getPlan: (id) => base.getPlan(id),
        applyPlan: (id, now) => base.applyPlan(id, now),
        saveLastResortConfirmation: (c, now) => base.saveLastResortConfirmation(c, now),
        consumeLastResortConfirmation: (id, h, now) => base.consumeLastResortConfirmation(id, h, now),
        recordGuardRejection: (r) => base.recordGuardRejection(r),
        listGuardRejections: () => base.listGuardRejections(),
        saveStormSession: (s) => base.saveStormSession(s),
        getLatestStormSession: () => base.getLatestStormSession(),
        claimStormSession: (s, k) => base.claimStormSession(s, k),
        saveInboxMessage: (m) => base.saveInboxMessage(m),
        listInbox: (n) => base.listInbox(n),
        getSandboxSettings: () => base.getSandboxSettings(),
        putSandboxSettings: (s, v) => base.putSandboxSettings(s, v),
        getAdminConfig: () => base.getAdminConfig(),
        putAdminConfig: (c, v) => base.putAdminConfig(c, v),
      };
    };
    const set = await call(deps({ storeFor }), 'set_preferences', { language: 'it-IT', confirmed: true });
    expect(set).toMatchObject({ isError: true, structuredContent: { code: 'store_unavailable', retryable: true } });
  });

  it('requires the person to have confirmed the change', async () => {
    expect(await call(deps(), 'set_preferences', { language: 'it-IT' })).toMatchObject({ isError: true, structuredContent: { code: 'invalid_input' } });
    expect(await call(deps(), 'set_preferences', { language: 'it-IT', confirmed: false })).toMatchObject({
      isError: true,
      structuredContent: { code: 'invalid_input' },
    });
  });

  it('refuses thresholds outside the hard limits and unknown rooms, and saves nothing', async () => {
    const d = deps();
    expect(await call(d, 'set_preferences', { safety: { cooling: { maxC: 35 } }, confirmed: true })).toMatchObject({
      isError: true,
      structuredContent: { code: 'safety_threshold_out_of_range', details: { nearestAllowed: 30 } },
    });
    expect(await call(d, 'set_preferences', { safeRoomId: 'attic', confirmed: true })).toMatchObject({
      isError: true,
      structuredContent: { code: 'unknown_room' },
    });
    expect((await call(d, 'get_preferences', {})).structuredContent).toMatchObject({ isDefault: true });
  });

  it('does not accept contacts through the model (they carry names)', async () => {
    const contacts = [{ role: 'son', name: 'Someone', channel: 'in_app', handle: 'phone-2' }];
    expect(await call(deps(), 'set_preferences', { familyContacts: contacts, confirmed: true })).toMatchObject({
      isError: true,
      structuredContent: { code: 'invalid_input' },
    });
  });

  it('keeps each home to itself: the home comes from the token', async () => {
    const d = deps();
    await call(d, 'set_preferences', { language: 'it-IT', confirmed: true });
    expect((await call(d, 'get_preferences', {}, HOME_TOKEN)).structuredContent).toMatchObject({ isDefault: true, preferences: { language: 'en-US' } });
  });

  it('reports an unreachable store as store_unavailable', async () => {
    const failing: StateStore = {
      homeId: 'demo' as HomeId,
      getPreferences: () => Promise.resolve({ ok: false, error: { code: 'store_unavailable', category: 'dependency_unavailable', message: 'Down.', retryable: true } }),
      putPreferences: () => Promise.reject(new Error('not used')),
      listConfigChanges: () => Promise.reject(new Error('not used')),
      savePlan: () => Promise.reject(new Error('not used')),
      getPlan: () => Promise.reject(new Error('not used')),
      applyPlan: () => Promise.reject(new Error('not used')),
      saveLastResortConfirmation: () => Promise.reject(new Error('not used')),
      consumeLastResortConfirmation: () => Promise.reject(new Error('not used')),
      recordGuardRejection: () => Promise.reject(new Error('not used')),
      listGuardRejections: () => Promise.reject(new Error('not used')),
      saveStormSession: () => Promise.reject(new Error('not used')),
      getLatestStormSession: () => Promise.reject(new Error('not used')),
      claimStormSession: () => Promise.reject(new Error('not used')),
      saveInboxMessage: () => Promise.reject(new Error('not used')),
      listInbox: () => Promise.reject(new Error('not used')),
      getSandboxSettings: () => Promise.reject(new Error('not used')),
      putSandboxSettings: () => Promise.reject(new Error('not used')),
      getAdminConfig: () => Promise.reject(new Error('not used')),
      putAdminConfig: () => Promise.reject(new Error('not used')),
    };
    expect(await call(deps({ storeFor: () => failing }), 'get_preferences', {})).toMatchObject({
      isError: true,
      structuredContent: { code: 'store_unavailable', retryable: true },
    });
  });

  it('reads and writes preferences through a store that knows the request correlation id (#368)', async () => {
    const id = '0b7f2b8e-4c1d-4a53-9e7a-5a1c3f6d9e10';
    const scopes: Array<string | undefined> = [];
    const inner = memoryStateStoreFactory({ backing: createMemoryBacking(), clock: { now: () => NOW_MS } });
    const d = deps({ storeFor: (home, scope) => { scopes.push(scope?.correlationId); return inner(home, scope); } });
    const { handler } = makeHandler({ modules: [preferencesModule(d)] });
    const headers = { authorization: `Bearer ${HOME_TOKEN}`, 'x-correlation-id': id };
    await post(handler, initializeRequest, headers);
    await post(handler, callTool('get_preferences', {}), headers);
    expect(scopes).toEqual([id]);
    await post(handler, callTool('set_preferences', { safety: { cooling: { maxC: 28 } }, confirmed: true }), headers);
    expect(scopes.length).toBeGreaterThan(1);
    expect(scopes.every((s) => s === id)).toBe(true);
  });
});
