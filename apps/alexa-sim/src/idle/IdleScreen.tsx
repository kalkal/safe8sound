import type { InboxMessage, Milestone, SafeRoomStatus } from '@cold-reserve/contracts';
import { homeClock, roomLabel, safeRoomHeadline } from '@cold-reserve/ui-cards';
import { Avatar, type AvatarKind } from '@cold-reserve/ui-cards/avatars';
import { BellOutline, IconFrame, MenuOutline, MessageDot, WeatherOutline } from '@cold-reserve/ui-cards/icons';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import type { PhoneFeed } from '../phone/phone-feed.js';
import { clockTime } from '../ui/sim-clock.js';
import type { Sky } from '../ui/sky.js';
import { t } from '../ui/text.js';

// The realistic Echo Show screen (#432 S6; owner 18 Oct; architettura/confronto-echo-show §1.1, §1.7). The top row
// of the real Alexa+ home: the menu and the notification bell top left (a bell with a dot when something is new,
// Amazon Help "Indicators for Alexa+"), the time and the weather top right. The weather is the sky's (owner D1 = a: no
// new data). At rest, translucent tiles over the sky like the real widgets: Leo's room with the time it stays safe until
// (read from the server at every jump, D2 = b), the cold reserve, and the next moment of the day. A new message to
// Ana comes first as a short line while it is unseen: our addition, the real bell has no such line.

const keyOf = (m: InboxMessage) => `${m.at}|${m.transition}|${m.role}`;

/** The messages Ana got since the bell was last touched (messages newest first); a new play of the day starts again. */
export function useNotices(phone: PhoneFeed): { unseen: number; newest: InboxMessage | undefined; markSeen: () => void } {
  const messages = useSyncExternalStore(phone.subscribe, phone.messages);
  const [seenKey, setSeenKey] = useState<string | undefined>(undefined);
  const seenAt = seenKey === undefined ? -1 : messages.findIndex((m) => keyOf(m) === seenKey);
  // The last seen message is gone (a new play cleared the phone): every message is new.
  const unseen = seenAt === -1 ? messages.length : seenAt;
  const newest = unseen > 0 ? messages[0] : undefined;
  const markSeen = useCallback(() => {
    const [first] = phone.messages();
    if (first !== undefined) setSeenKey(keyOf(first));
  }, [phone]);
  return { unseen, newest, markSeen };
}

const capitalised = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

export interface ScreenTopProps {
  /** The simulated time now (local ISO with its offset); none without a simulated clock. */
  now: string | undefined;
  sky: Sky;
  /** Messages to Ana not seen yet: the bell's dot. */
  unseen: number;
  onSeen: () => void;
  /** What the menu lists: "Show my home" and (#432 S5) "Settings". */
  menu: ReactNode;
  /** The home's face (homeFaceOf): Leo, or a small house when no one at risk is at home. */
  avatar: AvatarKind;
  /** The menu button, so the focus can come back to it when what it opened closes. */
  menuRef?: RefObject<HTMLButtonElement | null>;
}

export function ScreenTop({ now, sky, unseen, onSeen, menu, avatar, menuRef }: ScreenTopProps) {
  return (
    <>
      <div className="screen-icons">
        <ScreenMenu buttonRef={menuRef}>{menu}</ScreenMenu>
        <button type="button" className="screen-icon" data-new={unseen > 0} aria-label={unseen > 0 ? t('screen.notificationsNew', { count: String(unseen) }) : t('screen.notifications')} onClick={onSeen}>
          <IconFrame className="screen-icon-svg">
            <BellOutline />
            {unseen > 0 && <MessageDot className="screen-icon-dot" />}
          </IconFrame>
        </button>
      </div>
      {now !== undefined && (
        <p className="screen-clock">
          <span className="screen-weather">
            <IconFrame className="screen-weather-svg">
              <WeatherOutline sky={sky} />
            </IconFrame>
            <span data-testid="screen-weather">{t(`screen.weather.${sky}`)}</span>
          </span>
          <span className="screen-time" data-testid="screen-time">
            {clockTime(now)}
          </span>
          {/* The profile picture of the real home, top right: Leo, the one this home is set up for, or the house (homeFaceOf). */}
          <Avatar kind={avatar} className="screen-profile" />
        </p>
      )}
    </>
  );
}

/** The menu button, top left: its list opens under it; Escape, a choice or a touch elsewhere closes it. */
function ScreenMenu({ children, buttonRef }: { children: ReactNode; buttonRef: RefObject<HTMLButtonElement | null> | undefined }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const own = useRef<HTMLButtonElement>(null);
  const button = buttonRef ?? own;
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || box.current?.contains(event.target) !== true) setOpen(false);
    };
    window.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('pointerdown', outside);
    };
  }, [open]);
  return (
    <div className="screen-menu" ref={box}>
      <button
        ref={button}
        type="button"
        className="screen-icon"
        aria-label={t('screen.menu')}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <IconFrame className="screen-icon-svg">
          <MenuOutline />
        </IconFrame>
      </button>
      {open && (
        <div
          id={listId}
          className="screen-menu-list"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            setOpen(false);
            button.current?.focus();
          }}
          onClick={(event) => {
            // A choice closes the menu (the choice itself runs first).
            if (event.target instanceof Element && event.target.closest('button') !== null) setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export interface IdleTilesProps {
  room: SafeRoomStatus | undefined;
  /** The cold reserve's hours and cubes (ReserveClock). */
  reserve: ReactNode;
  next: Milestone | undefined;
  /** The newest message to Ana while it is unseen. */
  notice: InboxMessage | undefined;
  timeZone: string;
  /** The home's face, as on the top bar (homeFaceOf). */
  avatar: AvatarKind;
  /** False with no one at risk at home: the tile names no one's room ("Safe room"). */
  named?: boolean;
}

/** The tile says what the safe room card says (safeRoomHeadline): the same time, the same meaning. */
function headlineOf(room: SafeRoomStatus, timeZone: string): string {
  const headline = safeRoomHeadline(room);
  const time = homeClock(headline.until, timeZone);
  if (headline.kind === 'atLeast') return t(headline.tomorrow ? 'idle.atLeastTomorrow' : 'idle.atLeastUntil', { time });
  if (headline.kind === 'within') return t(headline.atLeast ? 'idle.withinAtLeast' : 'idle.withinUntil', { time });
  return t(headline.kind === 'held' ? 'idle.heldUntil' : 'idle.safeUntil', { time });
}

export function IdleTiles({ room, reserve, next, notice, timeZone, avatar, named = true }: IdleTilesProps) {
  return (
    <div className="idle-tiles">
      {notice !== undefined && (
        <section className="idle-tile idle-notice" data-testid="tile-notice">
          <p className="idle-tile-label">{t('idle.notice', { time: homeClock(notice.at, timeZone) })}</p>
          <p className="idle-tile-text">{t(`phone.${notice.transition}`)}</p>
        </section>
      )}
      {room !== undefined && (
        <section className="idle-tile idle-room" data-testid="tile-safe-room">
          <Avatar kind={avatar} className="idle-avatar" />
          <div>
            <p className="idle-tile-label">{named ? (room.safeRoomName ?? roomLabel(room.safeRoomId)) : t('idle.safeRoomNeutral')}</p>
            <p className="idle-tile-big">{headlineOf(room, timeZone)}</p>
          </div>
        </section>
      )}
      {reserve !== undefined && reserve !== null && (
        <div className="idle-tile idle-reserve" data-testid="tile-reserve">
          {reserve}
        </div>
      )}
      {next !== undefined && (
        <section className="idle-tile idle-next" data-testid="tile-next">
          <p className="idle-tile-label">{t('idle.next', { time: clockTime(next.at) })}</p>
          <p className="idle-tile-text">{capitalised(t(`clock.kind.${next.kind}`))}</p>
        </section>
      )}
    </div>
  );
}

const MORNING_FROM_H = 5;
const AFTERNOON_FROM_H = 12;
const EVENING_FROM_H = 18;

/**
 * The first line of the idle screen: the real Alexa+ home opens with one large personal sentence. Leo greeted by the
 * part of the day on the home's clock, by the fictional name the sandbox gives him (never a real name), plainly
 * without one. None without a simulated clock: the first screen then says what to ask.
 */
/** `named` false (no one at risk at home, owner 20 Oct, A): the greeting names no one. */
export function greetingOf(now: string | undefined, room: SafeRoomStatus | undefined, named = true): string | undefined {
  if (now === undefined) return undefined;
  const hour = Number(clockTime(now).slice(0, 2));
  const part = hour >= MORNING_FROM_H && hour < AFTERNOON_FROM_H ? 'morning' : hour >= AFTERNOON_FROM_H && hour < EVENING_FROM_H ? 'afternoon' : 'evening';
  const name = named ? room?.people?.find((p) => p.role === 'grandpa')?.name : undefined;
  return name === undefined ? t(`idle.greetingNoName.${part}`) : t(`idle.greeting.${part}`, { name });
}
