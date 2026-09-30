import { FamilyContactSchema, HomeIdSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { createInAppNotifier } from '../src/index.js';

const contact = FamilyContactSchema.parse({ role: 'daughter', name: 'Example Contact', channel: 'in_app', handle: 'phone-1' });
const demo = HomeIdSchema.parse('demo');
const other = HomeIdSchema.parse('demo#other0001');
const message = (text: string, at: string) => ({ homeId: demo, contact, transition: 'storm_started' as const, text, at });

describe('in-app notifier (the simulated phone)', () => {
  it('delivers to the inbox of the right home, newest first', async () => {
    const { notifier, inbox } = createInAppNotifier({ maxPerHome: 10 });
    expect(await notifier.send(message('first', '2026-07-17T13:00:00Z'))).toEqual({ ok: true, value: undefined });
    await notifier.send(message('second', '2026-07-17T13:05:00Z'));
    expect(inbox(demo).map((m) => m.text)).toEqual(['second', 'first']);
    expect(inbox(other)).toEqual([]);
  });

  it('keeps who it is for (role and name, for the phone screen) and the transition', async () => {
    const { notifier, inbox } = createInAppNotifier({ maxPerHome: 10 });
    await notifier.send(message('hello', '2026-07-17T13:00:00Z'));
    expect(inbox(demo)[0]).toEqual({ at: '2026-07-17T13:00:00Z', role: 'daughter', name: 'Example Contact', transition: 'storm_started', text: 'hello' });
  });

  it('keeps at most maxPerHome messages, dropping the oldest', async () => {
    const { notifier, inbox } = createInAppNotifier({ maxPerHome: 2 });
    for (const [i, t] of ['a', 'b', 'c'].entries()) await notifier.send(message(t, `2026-07-17T13:0${String(i)}:00Z`));
    expect(inbox(demo).map((m) => m.text)).toEqual(['c', 'b']);
  });

  it('refuses an empty message instead of delivering nothing', async () => {
    const { notifier } = createInAppNotifier({ maxPerHome: 2 });
    expect(await notifier.send(message('', '2026-07-17T13:00:00Z'))).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('returns copies: the caller cannot change a delivered message', async () => {
    const { notifier, inbox } = createInAppNotifier({ maxPerHome: 2 });
    await notifier.send(message('keep', '2026-07-17T13:00:00Z'));
    const [first] = inbox(demo);
    if (first) (first as { text: string }).text = 'changed';
    expect(inbox(demo)[0]?.text).toBe('keep');
  });
});
