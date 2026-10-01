import { err, ok, toolError, type ErrorEnvelope, type HomeId, type InboxMessage, type Result } from '@cold-reserve/contracts';
import type { Notifier, StateStoreFactory } from '@cold-reserve/core';

/**
 * Notifier for the simulated in-app phone: each delivered message is kept in the home's StateStore
 * (INBOX# items with their own TTL, #24), so the phone reads it from any process, locally and on
 * Lambda. The inbox is never exposed through an MCP tool: the text carries the contact's name.
 */
export const packageName = '@cold-reserve/notifier-inapp';

export interface InAppNotifier {
  readonly notifier: Notifier;
  /** Messages of one home still retained, newest first, at most `maxPerHome`. */
  readonly inbox: (homeId: HomeId) => Promise<Result<InboxMessage[], ErrorEnvelope>>;
}

export function createInAppNotifier(options: { storeFor: StateStoreFactory; maxPerHome: number }): Result<InAppNotifier, ErrorEnvelope> {
  if (!Number.isInteger(options.maxPerHome) || options.maxPerHome <= 0) {
    return err(toolError('invalid_config', 'The in-app notifier needs maxPerHome as a positive integer.'));
  }
  return ok({
    notifier: {
      send(message) {
        if (message.text.trim().length === 0) {
          return Promise.resolve(err(toolError('invalid_input', 'A family message cannot be empty.', { details: { field: 'text' } })));
        }
        // Role and channel only: the contact's name exists only inside the rendered text.
        return options.storeFor(message.homeId).saveInboxMessage({
          at: message.at,
          role: message.contact.role,
          channel: message.contact.channel,
          transition: message.transition,
          text: message.text,
        });
      },
    },
    inbox: (homeId) => options.storeFor(homeId).listInbox(options.maxPerHome),
  });
}
