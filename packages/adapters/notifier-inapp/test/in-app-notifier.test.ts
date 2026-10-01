import { FamilyContactSchema, HomeIdSchema, err, ok, toolError, type HomeId, type InboxMessage, type StormMessageText } from '@cold-reserve/contracts';
import type { StateStore, StateStoreFactory } from '@cold-reserve/core';
import { describe, expect, it } from 'vitest';
import { createInAppNotifier } from '../src/index.js';

// The notifier writes through the StateStore port; the store's own rules (validation, keys, TTL) are
// covered by the StateStore contract suite. Here a fake store records what reaches the port.

const contact = FamilyContactSchema.parse({ role: 'daughter', name: 'Example Contact', channel: 'in_app', handle: 'phone-1' });
const demo = HomeIdSchema.parse('demo');
const other = HomeIdSchema.parse('demo#other0001');
const T0 = Date.parse('2026-07-17T13:00:00Z');
// Test-only stand-in for a rendered template (the real text comes from @cold-reserve/i18n).
// eslint-disable-next-line no-restricted-syntax -- the adapter is tested without the templates
const text = (s: string) => s as unknown as StormMessageText;
const message = (s: string, minutes: number) => ({ homeId: demo, contact, transition: 'storm_started' as const, text: text(s), at: new Date(T0 + minutes * 60_000).toISOString() });

function fakeStores(save: (m: InboxMessage) => ReturnType<StateStore['saveInboxMessage']> = () => Promise.resolve(ok(undefined))) {
  const boxes = new Map<HomeId, InboxMessage[]>();
  const limits: number[] = [];
  const storeFor: StateStoreFactory = (homeId) =>
    ({
      homeId,
      saveInboxMessage: async (m: InboxMessage) => {
        const saved = await save(m);
        if (saved.ok) boxes.set(homeId, [m, ...(boxes.get(homeId) ?? [])]);
        return saved;
      },
      listInbox: (limit: number) => {
        limits.push(limit);
        return Promise.resolve(ok((boxes.get(homeId) ?? []).slice(0, limit)));
      },
    }) as unknown as StateStore;
  return { storeFor, boxes, limits };
}

function setup(maxPerHome = 10, save?: Parameters<typeof fakeStores>[0]) {
  const stores = fakeStores(save);
  const created = createInAppNotifier({ storeFor: stores.storeFor, maxPerHome });
  if (!created.ok) throw new Error(created.error.message);
  return { ...created.value, ...stores };
}

describe('in-app notifier (the simulated phone, persisted in the StateStore, #24)', () => {
  it('keeps each message in the store of its home: role, channel, transition and text, never the name or handle as fields', async () => {
    const { notifier, boxes } = setup();
    expect(await notifier.send(message('hello', 0))).toEqual({ ok: true, value: undefined });
    expect(boxes.get(demo)).toEqual([{ at: new Date(T0).toISOString(), role: 'daughter', channel: 'in_app', transition: 'storm_started', text: 'hello' }]);
    expect(boxes.get(other)).toBeUndefined();
  });

  it('lists the inbox of a home from the store, asking for at most maxPerHome', async () => {
    const { notifier, inbox, limits } = setup(2);
    await notifier.send(message('first', 0));
    await notifier.send(message('second', 1));
    const listed = await inbox(demo);
    expect(listed.ok && listed.value.map((m) => m.text)).toEqual(['second', 'first']);
    expect(limits).toEqual([2]);
  });

  it('refuses an empty message instead of delivering nothing, before reaching the store', async () => {
    const { notifier, boxes } = setup();
    expect(await notifier.send(message('  ', 0))).toMatchObject({ ok: false, error: { code: 'invalid_input', details: { field: 'text' } } });
    expect(boxes.size).toBe(0);
  });

  it('passes on what the store refuses or fails at: the storm records the message as not delivered', async () => {
    const down = setup(10, () => Promise.resolve(err(toolError('store_unavailable', 'The table is down.'))));
    expect(await down.notifier.send(message('hi', 0))).toMatchObject({ ok: false, error: { code: 'store_unavailable' } });
    const refused = setup(10, () => Promise.resolve(err(toolError('invalid_input', 'Bad time.', { details: { field: 'at' } }))));
    expect(await refused.notifier.send({ ...message('hi', 0), at: 'yesterday' })).toMatchObject({ ok: false, error: { code: 'invalid_input', details: { field: 'at' } } });
  });

  it('refuses a configuration that would silently list nothing', () => {
    const { storeFor } = fakeStores();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(createInAppNotifier({ storeFor, maxPerHome: bad })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    }
  });
});
