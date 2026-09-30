import { IsoDateTimeSchema, err, ok, toolError, type ErrorEnvelope, type HomeId, type Result, type SendableTransition } from '@cold-reserve/contracts';
import type { Clock, Notifier } from '@cold-reserve/core';

/**
 * Notifier for the simulated in-app phone: messages land in a per-home inbox the web app shows.
 * The inbox lives in memory, for local runs and the E2E tests only; the persistent store behind the
 * phone comes with F8c and the deploy.
 */
export const packageName = '@cold-reserve/notifier-inapp';

/** A delivered message as listed: role and channel. The contact's name exists only inside `text`. */
export interface InAppMessage {
  readonly at: string;
  readonly role: string;
  readonly channel: 'in_app';
  readonly transition: SendableTransition;
  readonly text: string;
}

export interface InAppNotifier {
  readonly notifier: Notifier;
  /** Messages of one home still retained, newest first. */
  readonly inbox: (homeId: HomeId) => InAppMessage[];
}

const HOUR_MS = 3_600_000;
const positiveInteger = (n: number) => Number.isInteger(n) && n > 0;

export function createInAppNotifier(options: { maxPerHome: number; ttlHours: number; clock: Clock }): Result<InAppNotifier, ErrorEnvelope> {
  if (!positiveInteger(options.maxPerHome) || !positiveInteger(options.ttlHours)) {
    return err(toolError('invalid_config', 'The in-app notifier needs maxPerHome and ttlHours as positive integers.'));
  }
  const inboxes = new Map<string, InAppMessage[]>();
  const live = (m: InAppMessage) => options.clock.now() - Date.parse(m.at) < options.ttlHours * HOUR_MS;

  return ok({
    notifier: {
      send(message) {
        if (!IsoDateTimeSchema.safeParse(message.at).success) {
          return Promise.resolve(err(toolError('invalid_input', 'A family message needs an ISO 8601 time.', { details: { field: 'at' } })));
        }
        if (message.text.trim().length === 0) {
          return Promise.resolve(err(toolError('invalid_input', 'A family message cannot be empty.', { details: { field: 'text' } })));
        }
        const entry: InAppMessage = { at: message.at, role: message.contact.role, channel: message.contact.channel, transition: message.transition, text: message.text };
        const list = [entry, ...(inboxes.get(message.homeId) ?? []).filter(live)];
        inboxes.set(message.homeId, list.slice(0, options.maxPerHome));
        return Promise.resolve(ok(undefined));
      },
    },
    inbox: (homeId) => (inboxes.get(homeId) ?? []).filter(live).map((m) => ({ ...m })),
  });
}
