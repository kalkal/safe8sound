import { formatTemp, type InboxMessage, type PhoneReply, type TempUnit } from '@cold-reserve/contracts';
import { PRODUCT_NAME } from '@cold-reserve/i18n';
import { IconFrame, MessageDot, SmartphoneOutline } from '@cold-reserve/ui-cards/icons';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { t } from '../ui/text.js';
import type { PhoneFeed, PhoneReplyResult } from './phone-feed.js';

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

/** What the phone says after a reply, in words: never a code. */
function outcomeText(reply: PhoneReply, result: PhoneReplyResult, timeZone: string, units: TempUnit): string {
  if (!result.ok) {
    if (result.code === 'family_reply_rate_limited' && result.retryAfterMs !== undefined) return t('phone.tooSoon', { seconds: String(Math.ceil(result.retryAfterMs / 1000)) });
    return t('phone.notSent');
  }
  if (result.status !== undefined) return t('phone.status', { temp: formatTemp(result.status.tempC, units), time: clock(result.status.safeUntil, timeZone) });
  return t(reply === 'on_my_way' ? 'phone.sentOnMyWay' : 'phone.sentCheck');
}

/** The family's closed set of replies, by touch; one call at a time. "On my way" is the one bright button (sober colours, owner 10 Oct). */
function Replies({ reply, timeZone, units }: { reply: NonNullable<PhoneFeed['reply']>; timeZone: string; units: TempUnit }) {
  const [sending, setSending] = useState(false);
  const [said, setSaid] = useState<string | undefined>(undefined);
  // A second tap before the re-render must not send twice: the guard is a ref, the state only disables.
  const inFlight = useRef(false);
  const send = (answer: PhoneReply) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    void reply(answer).then((result) => {
      inFlight.current = false;
      setSaid(outcomeText(answer, result, timeZone, units));
      setSending(false);
    });
  };
  return (
    <div className="phone-replies" role="group" aria-label={t('phone.replies')}>
      <button type="button" className="button" disabled={sending} onClick={() => {
          send('on_my_way');
        }}>
        {t('phone.onMyWay')}
      </button>
      <button type="button" className="button button-quiet" disabled={sending} onClick={() => {
          send('check_status');
        }}>
        {t('phone.checkStatus')}
      </button>
      <p className="muted" role="status">
        {sending ? t('phone.sending') : (said ?? '')}
      </p>
    </div>
  );
}

/** Ana's phone as a connected device (owner feedback, 6 Oct): Lucide "smartphone" (ISC, see NOTICE) beside the title, hidden from screen readers. */
function PhoneIcon({ alert }: { alert: boolean }) {
  return (
    <IconFrame className="phone-icon" data={{ device: 'phone' }}>
      <SmartphoneOutline className="phone-icon-line" />
      {/* A message has arrived: the dot, as on a real phone (the list says it in words). */}
      {alert && <MessageDot className="phone-icon-dot" />}
    </IconFrame>
  );
}

/**
 * `units`: the temperature unit the person chose (°F everywhere, owner decision, 9 Oct); °C by default. `settings`
 * (#432 S5): Leo's home settings, the same page as the Echo's on the same model; a line opens it in place of the
 * messages, Back brings them again. None for the phone alone (?view=phone), which has no preferences to show.
 * `named` false (no one at risk at home, owner 20 Oct, A): the line names no one ("Manage home settings").
 */
export function PhonePanel({ feed, timeZone, units = 'C', settings, named = true }: { feed: PhoneFeed; timeZone: string; units?: TempUnit; settings?: ReactNode; named?: boolean }) {
  const messages = useSyncExternalStore(feed.subscribe, feed.messages);
  const titleId = useId();
  const [onSettings, setOnSettings] = useState(false);
  const manageRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  // The tapped button goes away with the view it opened: the focus moves to the other one, never lost on the page.
  const tapped = useRef(false);
  useEffect(() => {
    if (!tapped.current) return;
    tapped.current = false;
    (onSettings ? backRef : manageRef).current?.focus();
  }, [onSettings]);
  return (
    <section className="phone" aria-labelledby={titleId}>
      <h2 id={titleId}>
        <PhoneIcon alert={messages.length > 0} />
        {t('phone.title')}
      </h2>
      {settings !== undefined && onSettings ? (
        <div className="phone-settings">
          <button
            ref={backRef}
            type="button"
            className="link-button"
            onClick={() => {
              tapped.current = true;
              setOnSettings(false);
            }}
          >
            {t('nav.back')}
          </button>
          {settings}
        </div>
      ) : (
        <>
          {settings !== undefined && (
            <button
              ref={manageRef}
              type="button"
              className="chip-button phone-manage"
              onClick={() => {
                tapped.current = true;
                setOnSettings(true);
              }}
            >
              {t(named ? 'phone.manageSettings' : 'phone.manageHomeSettings')}
            </button>
          )}
          <PhoneMessages feed={feed} messages={messages} timeZone={timeZone} units={units} />
        </>
      )}
    </section>
  );
}

/** The messages to Ana, newest first, with the replies once there is something to answer to. */
function PhoneMessages({ feed, messages, timeZone, units }: { feed: PhoneFeed; messages: readonly InboxMessage[]; timeZone: string; units: TempUnit }) {
  return (
    <>
      {messages.length === 0 && (
        <>
          <p className="muted">{t('phone.empty')}</p>
          <p className="muted">{t('phone.whenTold')}</p>
        </>
      )}
      {/* Something to answer to: the replies come with the first message. */}
      {messages.length > 0 && feed.reply !== undefined && <Replies reply={feed.reply} timeZone={timeZone} units={units} />}
      <ol className="phone-list" aria-label={t('phone.list')} aria-live="polite">
        {messages.map((m) => (
          <li key={`${m.at}|${m.transition}|${m.role}`}>
            <Notification message={m} timeZone={timeZone} />
          </li>
        ))}
      </ol>
    </>
  );
}
