import type { ErrorEnvelope, FamilyContact, HomeId, Result, SendableTransition, StormNotification } from '@cold-reserve/contracts';

// Family messages (plan §11.2 p.8, §13.2.4): only to contacts registered in the preferences, never to
// a recipient said in conversation; at most once per transition and person within an interval, except
// "power is back", which always follows the earlier messages.

export interface NotificationPlan {
  readonly send: readonly FamilyContact[];
  readonly skipped: ReadonlyArray<{ readonly role: string; readonly reason: 'not_registered' | 'rate_limited' }>;
}

export function planNotifications(input: {
  contacts: readonly FamilyContact[];
  /** Roles asked for; every registered contact when absent. */
  roles?: readonly string[];
  transition: SendableTransition;
  sent: readonly StormNotification[];
  nowMs: number;
  minIntervalMinutes: number;
}): NotificationPlan {
  const wanted = [...new Set(input.roles ?? input.contacts.map((c) => c.role))];
  const send: FamilyContact[] = [];
  const skipped: Array<NotificationPlan['skipped'][number]> = [];
  for (const role of wanted) {
    const target = input.contacts.find((c) => c.role === role);
    if (!target) {
      skipped.push({ role, reason: 'not_registered' });
      continue;
    }
    const recent = input.sent.some(
      (n) => n.contactRole === role && n.transition === input.transition && input.nowMs - Date.parse(n.at) < input.minIntervalMinutes * 60_000,
    );
    if (recent && input.transition !== 'power_back') skipped.push({ role, reason: 'rate_limited' });
    else send.push(target);
  }
  return { send, skipped };
}

/** One message to one registered contact, already rendered from a template. */
export interface OutgoingMessage {
  readonly homeId: HomeId;
  readonly contact: FamilyContact;
  readonly transition: SendableTransition;
  readonly text: string;
  readonly at: string;
}

/** Notifier port: the in-app phone for the hackathon; SES or Telegram later. */
export interface Notifier {
  send(message: OutgoingMessage): Promise<Result<void, ErrorEnvelope>>;
}
