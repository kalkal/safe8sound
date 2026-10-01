import { HomeIdSchema, InboxMessageSchema, PlanSchema, PreferencesSchema, SENDABLE_TRANSITIONS } from '@cold-reserve/contracts';
import { examplePlan, examplePreferences } from '@cold-reserve/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import { createMemoryBacking, memoryStateStoreFactory } from '../src/index.js';

// The same read policy as store-dynamodb (R7, #111): a stored item with a field this version does not know is
// still read, without that field.

const HOME = HomeIdSchema.parse('demo');

describe('memory store: tolerant reads', () => {
  it('reads preferences and plans that carry a field a newer version added', async () => {
    const backing = createMemoryBacking();
    const plan = PlanSchema.parse(examplePlan());
    const prefs = PreferencesSchema.parse(examplePreferences());
    backing.partitions.set(
      `HOME#${HOME}`,
      new Map([
        ['PREFS', { value: { ...prefs, addedLater: true } }],
        [`PLAN#${plan.id}`, { value: { ...plan, futureHint: 'x' } }],
      ]),
    );
    const store = memoryStateStoreFactory({ backing, clock: { now: () => Date.parse(plan.createdAt) } })(HOME);
    expect(await store.getPreferences()).toEqual({ ok: true, value: prefs });
    expect(await store.getPlan(plan.id)).toEqual({ ok: true, value: plan });
  });

  it('reads family messages the same way', async () => {
    const message = InboxMessageSchema.parse({ at: '2026-07-17T13:00:00.000Z', role: 'daughter', channel: 'in_app', transition: SENDABLE_TRANSITIONS[0], text: 'Hello.' });
    const backing = createMemoryBacking();
    backing.partitions.set(`HOME#${HOME}`, new Map([['INBOX#2026-07-17T13:00:00.000Z#000000000001', { value: { ...message, addedLater: 1 } }]]));
    const store = memoryStateStoreFactory({ backing, clock: { now: () => Date.parse(message.at) } })(HOME);
    expect(await store.listInbox(10)).toEqual({ ok: true, value: [message] });
  });

  it('reports an item that does not match its schema, as store-dynamodb does', async () => {
    const backing = createMemoryBacking();
    backing.partitions.set(`HOME#${HOME}`, new Map([['PREFS', { value: { language: 'klingon' } }]]));
    const store = memoryStateStoreFactory({ backing, clock: { now: () => 0 } })(HOME);
    expect(await store.getPreferences()).toMatchObject({ ok: false, error: { code: 'unexpected_error' } });
  });
});
