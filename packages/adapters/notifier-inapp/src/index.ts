import { err, ok, toolError, type HomeId, type SendableTransition } from '@cold-reserve/contracts';
import type { Notifier } from '@cold-reserve/core';

/** Notifier for the simulated in-app phone: messages land in a per-home inbox the web app shows. */
export const packageName = '@cold-reserve/notifier-inapp';

/** A delivered message as the phone shows it. The name is for the phone screen only, never the model. */
export interface InAppMessage {
  readonly at: string;
  readonly role: string;
  readonly name: string;
  readonly transition: SendableTransition;
  readonly text: string;
}

export interface InAppNotifier {
  readonly notifier: Notifier;
  /** Messages of one home, newest first. */
  readonly inbox: (homeId: HomeId) => InAppMessage[];
}

export function createInAppNotifier(options: { maxPerHome: number }): InAppNotifier {
  const inboxes = new Map<string, InAppMessage[]>();
  return {
    notifier: {
      send(message) {
        if (message.text.trim().length === 0) {
          return Promise.resolve(err(toolError('invalid_input', 'A family message cannot be empty.', { details: { field: 'text' } })));
        }
        const list = inboxes.get(message.homeId) ?? [];
        list.unshift({ at: message.at, role: message.contact.role, name: message.contact.name, transition: message.transition, text: message.text });
        inboxes.set(message.homeId, list.slice(0, options.maxPerHome));
        return Promise.resolve(ok(undefined));
      },
    },
    inbox: (homeId) => (inboxes.get(homeId) ?? []).map((m) => ({ ...m })),
  };
}
