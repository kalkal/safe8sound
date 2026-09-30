import { FamilyContactSchema, HomeIdSchema, type StormMessageText } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { createInAppNotifier, type InAppNotifier } from '../src/index.js';

const contact = FamilyContactSchema.parse({ role: 'daughter', name: 'Example Contact', channel: 'in_app', handle: 'phone-1' });
const demo = HomeIdSchema.parse('demo');
const other = HomeIdSchema.parse('demo#other0001');
const T0 = Date.parse('2026-07-17T13:00:00Z');
// Test-only stand-in for a rendered template (the real text comes from @cold-reserve/i18n).
// eslint-disable-next-line no-restricted-syntax -- the adapter is tested without the templates
const text = (s: string) => s as unknown as StormMessageText;
const message = (s: string, minutes: number) => ({ homeId: demo, contact, transition: 'storm_started' as const, text: text(s), at: new Date(T0 + minutes * 60_000).toISOString() });

function setup(maxPerHome = 10, ttlHours = 48) {
  let now = T0;
  const created = createInAppNotifier({ maxPerHome, ttlHours, clock: { now: () => now } });
  if (!created.ok) throw new Error(created.error.message);
  const value: InAppNotifier = created.value;
  return { ...value, setNow: (ms: number) => (now = ms) };
}

describe('in-app notifier (the simulated phone; in memory, local runs and E2E only)', () => {
  it('delivers to the inbox of the right home, newest first', async () => {
    const { notifier, inbox } = setup();
    expect(await notifier.send(message('first', 0))).toEqual({ ok: true, value: undefined });
    await notifier.send(message('second', 5));
    expect(inbox(demo).map((m) => m.text)).toEqual(['second', 'first']);
    expect(inbox(other)).toEqual([]);
  });

  it('lists role, channel, transition and text: the name only inside the delivered text', async () => {
    const { notifier, inbox } = setup();
    await notifier.send(message('hello', 0));
    expect(inbox(demo)[0]).toEqual({ at: new Date(T0).toISOString(), role: 'daughter', channel: 'in_app', transition: 'storm_started', text: 'hello' });
    expect(JSON.stringify(inbox(demo))).not.toContain('Example Contact');
  });

  it('keeps at most maxPerHome messages, dropping the oldest', async () => {
    const { notifier, inbox } = setup(2);
    for (const [i, t] of ['a', 'b', 'c'].entries()) await notifier.send(message(t, i));
    expect(inbox(demo).map((m) => m.text)).toEqual(['c', 'b']);
  });

  it('forgets messages older than ttlHours', async () => {
    const { notifier, inbox, setNow } = setup(10, 48);
    await notifier.send(message('old', 0));
    setNow(T0 + 48 * 3_600_000 - 1);
    expect(inbox(demo)).toHaveLength(1);
    setNow(T0 + 48 * 3_600_000);
    expect(inbox(demo)).toEqual([]);
  });

  it('refuses an empty message instead of delivering nothing', async () => {
    const { notifier } = setup();
    expect(await notifier.send(message('  ', 0))).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('refuses a message whose time is not ISO 8601', async () => {
    const { notifier } = setup();
    expect(await notifier.send({ ...message('hi', 0), at: 'yesterday' })).toMatchObject({ ok: false, error: { code: 'invalid_input', details: { field: 'at' } } });
  });

  it('refuses a configuration that would silently drop everything', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(createInAppNotifier({ maxPerHome: bad, ttlHours: 48, clock: { now: () => T0 } })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
      expect(createInAppNotifier({ maxPerHome: 10, ttlHours: bad, clock: { now: () => T0 } })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    }
  });

  it('returns copies: the caller cannot change a delivered message', async () => {
    const { notifier, inbox } = setup();
    await notifier.send(message('keep', 0));
    const [first] = inbox(demo);
    if (first) (first as { text: string }).text = 'changed';
    expect(inbox(demo)[0]?.text).toBe('keep');
  });
});
