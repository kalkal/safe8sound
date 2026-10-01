import { describe, expect, it } from 'vitest';
import { INBOX_MAX_MESSAGES, InboxMessageSchema, PhoneInboxSchema, type NewInboxMessage } from '../src/inbox.js';

const message = {
  at: '2026-07-17T15:30:00Z',
  role: 'daughter',
  channel: 'in_app',
  transition: 'storm_started',
  text: 'Cold Reserve alert for Giulia Example: a storm cut the power at home.',
};

describe('InboxMessageSchema (the family phone, approved in #24)', () => {
  it('takes a delivered message: time, role, channel, transition and the rendered text', () => {
    expect(InboxMessageSchema.parse(message)).toEqual(message);
  });

  it('refuses an empty text, a transition that is never sent, a free-form role and extra fields', () => {
    expect(InboxMessageSchema.safeParse({ ...message, text: '' }).success).toBe(false);
    expect(InboxMessageSchema.safeParse({ ...message, transition: 'storm_prepared' }).success).toBe(false);
    expect(InboxMessageSchema.safeParse({ ...message, role: 'Giulia' }).success).toBe(false);
    expect(InboxMessageSchema.safeParse({ ...message, handle: 'phone-1' }).success).toBe(false);
  });

  it('caps a message at 600 characters', () => {
    expect(InboxMessageSchema.safeParse({ ...message, text: 'x'.repeat(600) }).success).toBe(true);
    expect(InboxMessageSchema.safeParse({ ...message, text: 'x'.repeat(601) }).success).toBe(false);
  });
});

describe('PhoneInboxSchema', () => {
  it('lists at most the retained messages, newest first by contract of the route', () => {
    expect(PhoneInboxSchema.parse({ messages: [message] }).messages).toHaveLength(1);
    expect(PhoneInboxSchema.safeParse({ messages: Array.from({ length: INBOX_MAX_MESSAGES + 1 }, () => message) }).success).toBe(false);
  });
});

describe('NewInboxMessage (review of #116)', () => {
  it('takes only template-rendered text: a plain string does not type-check', () => {
    const parsed = InboxMessageSchema.parse(message);
    // @ts-expect-error -- the text must come from stormMessage in @cold-reserve/i18n (StormMessageText)
    const free: NewInboxMessage = { ...parsed, text: 'free text from anywhere' };
    expect(free.text).toBe('free text from anywhere');
  });
});
