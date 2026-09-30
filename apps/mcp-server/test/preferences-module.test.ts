import { PreferencesSchema, SafetyHardLimitsSchema, type HomeId } from '@cold-reserve/contracts';
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
    expect(byName['set_preferences']).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
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
        applyPlan: (id) => base.applyPlan(id),
        recordGuardRejection: (r) => base.recordGuardRejection(r),
        listGuardRejections: () => base.listGuardRejections(),
        saveStormSession: (s) => base.saveStormSession(s),
        getLatestStormSession: () => base.getLatestStormSession(),
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
      recordGuardRejection: () => Promise.reject(new Error('not used')),
      listGuardRejections: () => Promise.reject(new Error('not used')),
      saveStormSession: () => Promise.reject(new Error('not used')),
      getLatestStormSession: () => Promise.reject(new Error('not used')),
    };
    expect(await call(deps({ storeFor: () => failing }), 'get_preferences', {})).toMatchObject({
      isError: true,
      structuredContent: { code: 'store_unavailable', retryable: true },
    });
  });
});
