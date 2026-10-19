import type { InboxMessage } from '@cold-reserve/contracts';
import { homeClock } from '@cold-reserve/ui-cards';
import { Avatar } from '@cold-reserve/ui-cards/avatars';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../ui/text.js';
import { useModal } from '../ui/use-modal.js';

// Ana's phone below the side-by-side width (#432, owner J = a): there the page scrolled to reach the phone stacked
// under the Echo. Now a button of the top bar opens it as a modal sheet; the button, Escape or a tap outside closes
// it. A new message to Ana (the moment the story is about) never blocks the page (owner K = b, 19 Oct): a notice shows
// under the top bar for a few seconds (config.phonePeekMs), with "Open Ana's phone". Where the phone fits beside the
// Echo it is always shown, as before, and needs no notice.

/** Where the phone stands beside the Echo (the Echo layout's CSS uses the same width: 768 px, owner 19 Oct: from a small Echo up). */
export const PHONE_BESIDE = '(width >= 48rem)';

export function usePhoneSheet({ beside, messages, peekMs }: { beside: boolean; messages: readonly InboxMessage[]; peekMs: number }) {
  const [open, setOpen] = useState(false);
  const [peek, setPeek] = useState<InboxMessage | undefined>(undefined);
  const opener = useRef<HTMLButtonElement>(null);
  // A new message shows the notice; the messages already there, or fewer after a new play of the day, do not.
  const seen = useRef(messages.length);
  const newest = messages[0];
  useEffect(() => {
    if (messages.length > seen.current && !beside) setPeek(newest);
    if (messages.length < seen.current) setPeek(undefined);
    seen.current = messages.length;
  }, [messages.length, newest, beside]);
  useEffect(() => {
    if (peek === undefined) return undefined;
    const timer = setTimeout(() => {
      setPeek(undefined);
    }, peekMs);
    return () => {
      clearTimeout(timer);
    };
  }, [peek, peekMs]);
  const openPhone = () => {
    setPeek(undefined);
    setOpen(true);
  };
  return { open, setOpen, opener, peek, openPhone };
}
type Sheet = ReturnType<typeof usePhoneSheet>;

/**
 * The notice of a new message to Ana, under the top bar: never modal, gone by itself after a few seconds. The live
 * region stays mounted and the notice is put into it, so screen readers announce it (review of #458).
 */
export function PhonePeek({ sheet, timeZone }: { sheet: Sheet; timeZone: string }) {
  const { peek } = sheet;
  return (
    <div className="phone-peek-live" role="status" data-testid="phone-peek-live">
      {peek !== undefined && (
        <div className="phone-peek" data-testid="phone-peek">
          <Avatar kind="adult-woman" className="phone-peek-avatar" />
          <p>
            <strong>{t('phone.peek', { time: homeClock(peek.at, timeZone) })}</strong>
            <br />
            {t(`phone.${peek.transition}`)}
          </p>
          <button type="button" className="chip-button" onClick={sheet.openPhone}>
            {t('phone.peekOpen')}
          </button>
        </div>
      )}
    </div>
  );
}

export function PhoneOpener({ sheet, beside, count }: { sheet: Sheet; beside: boolean; count: number }) {
  if (beside) return null;
  return (
    <button
      ref={sheet.opener}
      type="button"
      className="chip-button phone-open"
      aria-haspopup="dialog"
      aria-expanded={sheet.open}
      onClick={() => {
        sheet.setOpen(true);
      }}
    >
      {count > 0 ? t('phone.openCount', { count: String(count) }) : t('phone.open')}
    </button>
  );
}

export function PhoneSheet({ sheet, beside, children }: { sheet: Sheet; beside: boolean; children: ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const modal = !beside && sheet.open;
  const close = () => {
    sheet.setOpen(false);
  };
  useModal({ open: modal, close, dialog: dialogRef, layer: layerRef, opener: sheet.opener });
  if (beside) return <>{children}</>;
  if (!sheet.open) return null;
  return (
    <div ref={layerRef} className="settings-layer">
      <div className="settings-scrim" aria-hidden="true" onClick={close} />
      <div ref={dialogRef} className="settings-drawer phone-sheet" role="dialog" aria-modal="true" aria-label={t('phone.open')} tabIndex={-1}>
        <div className="settings-head">
          <span />
          <button type="button" className="link-button" onClick={close}>
            {t('settings.close')}
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
