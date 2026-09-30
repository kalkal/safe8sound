import type { ErrorEnvelope, FamilyContact, HomeId, Result, SendableTransition, StormMessageText, StormNotification } from '@cold-reserve/contracts';

// Family messages (plan §11.2 p.8, §13.2.4): only to contacts registered in the preferences, never to
// a recipient said in conversation; at most once per transition and person within an interval, except
// "power is back", which always follows the earlier messages. A failed delivery does not count
// against the interval: the person was not told, so they may still be.

export interface NotificationPlan {
  /** Internal: the registered contacts to deliver to. Never returned to the model. */
  readonly deliveries: readonly FamilyContact[];
  /** What the model may see: roles and channels only, in the same order as `deliveries`. */
  readonly sent: ReadonlyArray<{ readonly role: string; readonly channel: FamilyContact['channel'] }>;
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
  const deliveries: FamilyContact[] = [];
  const skipped: Array<NotificationPlan['skipped'][number]> = [];
  for (const role of wanted) {
    const target = input.contacts.find((c) => c.role === role);
    if (!target) {
      skipped.push({ role, reason: 'not_registered' });
      continue;
    }
    const recent = input.sent.some(
      (n) =>
        n.delivered &&
        n.contactRole === role &&
        n.transition === input.transition &&
        input.nowMs - Date.parse(n.at) < input.minIntervalMinutes * 60_000,
    );
    if (recent && input.transition !== 'power_back') skipped.push({ role, reason: 'rate_limited' });
    else deliveries.push(target);
  }
  return { deliveries, sent: deliveries.map((c) => ({ role: c.role, channel: c.channel })), skipped };
}

/** One message to one registered contact. The text can only come from the i18n templates. */
export interface OutgoingMessage {
  readonly homeId: HomeId;
  readonly contact: FamilyContact;
  readonly transition: SendableTransition;
  readonly text: StormMessageText;
  readonly at: string;
}

/** Notifier port: the in-app phone for the hackathon; SES or Telegram later. */
export interface Notifier {
  send(message: OutgoingMessage): Promise<Result<void, ErrorEnvelope>>;
}
