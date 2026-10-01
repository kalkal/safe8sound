import { FamilyContactSchema, HomeIdSchema } from '@cold-reserve/contracts';
import { fixedClock } from '@cold-reserve/core';
import { stormMessage } from '@cold-reserve/i18n';
import { dynamoStateStoreFactory } from '@cold-reserve/store-dynamodb';
import { createFakeTable } from '@cold-reserve/store-dynamodb/testing';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadPreferencesConfig, preferencesConfigFile } from '../src/preferences-config.js';
import { stormModeWiring } from '../src/storm-mode-config.js';
import { TOKEN } from './helpers.js';

const clock = fixedClock(Date.parse('2026-09-30T10:00:00Z'));

function wiring() {
  const p = loadPreferencesConfig(preferencesConfigFile());
  if (!p.ok) throw new Error(p.error.message);
  const w = stormModeWiring({ storeFor: memoryStateStoreFactory({ backing: createMemoryBacking(), clock }), preferences: p.value, clock });
  if (!w.ok) throw new Error(w.error.message);
  return w.value;
}

describe('storm-mode wiring', () => {
  it('loads the shipped config and starts with an empty phone', async () => {
    const w = wiring();
    expect(w.config.capHours).toBe(24);
    expect(await w.inbox(HomeIdSchema.parse('demo'))).toEqual({ ok: true, value: [] });
  });

  it('keeps the phone in the StateStore: a later invocation on the same table reads what an earlier one sent', async () => {
    const p = loadPreferencesConfig(preferencesConfigFile());
    if (!p.ok) throw new Error(p.error.message);
    const table = createFakeTable();
    const storeFor = () => dynamoStateStoreFactory({ table, clock, rng: { next: Math.random } });
    const first = stormModeWiring({ storeFor: storeFor(), preferences: p.value, clock });
    const later = stormModeWiring({ storeFor: storeFor(), preferences: p.value, clock });
    if (!first.ok || !later.ok) throw new Error('wiring failed');
    const demo = HomeIdSchema.parse('demo');
    const contact = FamilyContactSchema.parse({ role: 'daughter', name: 'Example Contact', channel: 'in_app', handle: 'phone-1' });
    const text = stormMessage('en-US', 'power_back', contact.name, { roomName: 'Bedroom', tempC: 26, atMs: clock.now(), powerBackAtMs: clock.now(), timeZone: 'Europe/Rome' });
    if (!text.ok) throw new Error('template');
    expect(await first.value.notifier.send({ homeId: demo, contact, transition: 'power_back', text: text.value, at: new Date(clock.now()).toISOString() })).toEqual({ ok: true, value: undefined });
    const listed = await later.value.inbox(demo);
    expect(listed.ok && listed.value.map((m) => `${m.transition}:${m.role}`)).toEqual(['power_back:daughter']);
  });

  it('storm ids are fresh and valid', () => {
    const w = wiring();
    const a = w.newStormId();
    expect(a).toMatch(/^storm_[A-Za-z0-9]{20}$/);
    expect(w.newStormId()).not.toBe(a);
  });

  it('the app registers the three tools when the module is wired, and none without it', () => {
    const names = (stormMode?: ReturnType<typeof wiring>) => {
      const app = createApp({ MCP_CLIENTS: `agent@demo=${TOKEN}` }, { wallClock: clock, logger: { log: () => undefined }, ...(stormMode ? { stormMode } : {}) });
      if (!app.ok) throw new Error(app.error.message);
      return app.value.registry.toolsFor(HomeIdSchema.parse('demo')).map((t) => t.name);
    };
    expect(names(wiring())).toEqual(expect.arrayContaining(['start_storm_mode', 'get_safe_room_status', 'notify_family']));
    expect(names()).not.toContain('notify_family');
  });
});
