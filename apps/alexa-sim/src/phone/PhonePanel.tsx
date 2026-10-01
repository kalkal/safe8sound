import type { InboxMessage } from '@cold-reserve/contracts';
import { PRODUCT_NAME } from '@cold-reserve/i18n';
import { useId, useSyncExternalStore } from 'react';
import { t } from '../ui/text.js';
import type { PhoneFeed } from './phone-feed.js';

// Surface C (plan §11.1, §11.3): the phone of the family member away from home. It shows the
// Mileti-style messages the server sent, newest first; new ones are announced politely (the
// assertive announcement belongs to the storm's entry on the home screen, plan §11.2 p.13).

const clock = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(Date.parse(iso));

function Notification({ message, timeZone }: { message: InboxMessage; timeZone: string }) {
  const titleId = useId();
  return (
    <article className="phone-note" aria-labelledby={titleId} data-transition={message.transition}>
      <p className="phone-meta">{`${PRODUCT_NAME} · ${clock(message.at, timeZone)}`}</p>
      <h3 id={titleId}>{t(`phone.${message.transition}`)}</h3>
      <p>{message.text}</p>
    </article>
  );
}

export function PhonePanel({ feed, timeZone }: { feed: PhoneFeed; timeZone: string }) {
  const messages = useSyncExternalStore(feed.subscribe, feed.messages);
  const titleId = useId();
  return (
    <section className="phone" aria-labelledby={titleId}>
      <h2 id={titleId}>{t('phone.title')}</h2>
      {messages.length === 0 && <p className="muted">{t('phone.empty')}</p>}
      <ol className="phone-list" aria-label={t('phone.list')} aria-live="polite">
        {messages.map((m) => (
          <li key={`${m.at}|${m.transition}|${m.role}`}>
            <Notification message={m} timeZone={timeZone} />
          </li>
        ))}
      </ol>
    </section>
  );
}
