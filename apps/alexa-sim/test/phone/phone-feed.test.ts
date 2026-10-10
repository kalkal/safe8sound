import { InboxMessageSchema } from '@cold-reserve/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createScriptedPhone } from '../../src/phone/phone-feed.js';
import { PHONE_FIXTURES, phoneMessage } from '../../src/phone/phone-fixtures.js';

describe('the scripted phone feed (surface C, #24)', () => {
  it('starts empty and shows delivered messages newest first', () => {
    const phone = createScriptedPhone();
    expect(phone.messages()).toEqual([]);
    phone.deliver([phoneMessage('storm-started')]);
    phone.deliver([phoneMessage('power-back')]);
    expect(phone.messages().map((m) => m.transition)).toEqual(['power_back', 'storm_started']);
  });

  it('tells its subscribers, and stops when they unsubscribe', () => {
    const phone = createScriptedPhone();
    const listener = vi.fn();
    const stop = phone.subscribe(listener);
    phone.deliver([phoneMessage('storm-started')]);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    phone.deliver([phoneMessage('essential')]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('shows the same message once, however often the scene is replayed', () => {
    const phone = createScriptedPhone();
    phone.deliver([phoneMessage('storm-started')]);
    phone.deliver([phoneMessage('storm-started')]);
    expect(phone.messages()).toHaveLength(1);
  });

  it('keeps the same snapshot until something changes (useSyncExternalStore needs it)', () => {
    const phone = createScriptedPhone();
    const before = phone.messages();
    expect(phone.messages()).toBe(before);
    phone.deliver([phoneMessage('storm-started')]);
    expect(phone.messages()).not.toBe(before);
  });
});

describe('phone fixtures: real templates, valid contract messages', () => {
  it('renders each transition with the i18n template, addressed to the contact by name', () => {
    for (const name of Object.keys(PHONE_FIXTURES) as (keyof typeof PHONE_FIXTURES)[]) {
      const m = InboxMessageSchema.parse(phoneMessage(name));
      expect(m.role).toBe('daughter');
      expect(m.text).toContain('for Ana:');
    }
    expect(phoneMessage('power-back').text).toContain('power came back at home at 5:48');
    expect(phoneMessage('storm-started').text).toContain('keeps it safe until 6:40');
  });

  it('the scripted phone accepts a reply and never invents a safe-room status (no numbers off the script)', async () => {
    const phone = createScriptedPhone();
    expect(await phone.reply?.('on_my_way')).toEqual({ ok: true });
    expect(await phone.reply?.('check_status')).toEqual({ ok: true });
  });
});
