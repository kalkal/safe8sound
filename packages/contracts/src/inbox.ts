import { z } from 'zod';
import { IsoDateTimeSchema, RoleSchema } from './common.js';
import { ContactChannelSchema } from './preferences.js';
import { SendableTransitionSchema, type StormMessageText } from './storm.js';

// The family phone's inbox (plan §11.2 p.8, §11.3): additive, approved in #24.
// The text carries the contact's name, so it is read only by the phone route with a phone-scoped
// token, never through an MCP tool the model sees.

export const INBOX_MAX_MESSAGES = 50;

/** One delivered family message, as the phone shows it. */
export const InboxMessageSchema = z.strictObject({
  at: IsoDateTimeSchema,
  role: RoleSchema,
  channel: ContactChannelSchema,
  transition: SendableTransitionSchema,
  /** Rendered by stormMessage in @cold-reserve/i18n; never written by the model. */
  text: z.string().min(1).max(600),
});
export type InboxMessage = z.infer<typeof InboxMessageSchema>;

/** What may be saved: only text rendered by the i18n templates (`StormMessageText`), never a plain string. */
export type NewInboxMessage = Omit<InboxMessage, 'text'> & { readonly text: StormMessageText };

/** The phone route's answer: the retained messages of the home, newest first. */
export const PhoneInboxSchema = z.strictObject({
  messages: z.array(InboxMessageSchema).max(INBOX_MAX_MESSAGES),
});
export type PhoneInbox = z.infer<typeof PhoneInboxSchema>;
