import type { HomeStatus } from '@cold-reserve/contracts';
import { useCallback, useId, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { t } from './text.js';

// "Show my home" (#204): the floor plan with the rooms, temperatures, battery, solar and grid, behind one button so the
// screen stays clean. A disclosure, not a dialog: the rest of the page stays usable; Escape closes it and the focus
// goes back to the button.

export interface HomePanelProps {
  status: HomeStatus | undefined;
  /** Draws the home card (a ui:// frame in the simulator). */
  renderCard: (status: HomeStatus) => ReactNode;
  /** Remote mode (#262): the read of the home on demand, while it comes or when it failed; `locked` before the demo code (no read). */
  load?: 'idle' | 'loading' | 'failed' | 'locked';
  /** Called each time the panel opens: the remote home is read then. */
  onOpen?: () => void;
  onRetry?: () => void;
  /** Each time the home opens, tapped or said, before the demo code too (#432 S5: the settings page then closes). */
  onShow?: () => void;
  /** Escape closed the home while its button is not on the page (#432 S6: it sits in the screen's closed menu). */
  onFocusLost?: () => void;
}

/**
 * Three bands (owner, 10 Oct): the button goes in the header band (#432 S6: in the screen's menu), the home in the
 * content band, in place of the answer. `view` is null while the home is closed.
 */
export function useHomePanel({ status, renderCard, load = 'idle', onOpen: onOpenProp, onShow, onRetry, onFocusLost }: HomePanelProps): { button: ReactElement; view: ReactElement | null; open: () => void; close: () => void } {
  const [open, setOpen] = useState(false);
  // Before the demo code there is no home to read (owner, 18 Oct): no read, so no failure to show.
  const onOpen = load === 'locked' ? undefined : onOpenProp;
  const panelId = useId();
  const titleId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Escape on the button or anywhere in the home closes it. Inside the card frame the card has its own keys.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return;
    setOpen(false);
    if (buttonRef.current === null) onFocusLost?.();
    else buttonRef.current.focus();
  };
  const button = (
    <button
      ref={buttonRef}
      type="button"
      className="chip-button"
      aria-expanded={open}
      aria-controls={panelId}
      onKeyDown={onKeyDown}
      onClick={() => {
        if (!open) {
          onShow?.();
          onOpen?.();
        }
        setOpen(!open);
      }}
    >
      {t(open ? 'home.hide' : 'home.show')}
    </button>
  );
  const view = open ? (
    <section id={panelId} className="home-panel-body" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <h2 id={titleId} className="visually-hidden">
        {t('home.title')}
      </h2>
      {load === 'locked' && <p className="notice">{t('home.needsCode')}</p>}
      {load === 'loading' && (
        <p className="notice" role="status">
          {t('home.loading')}
        </p>
      )}
      {load === 'failed' && (
        <div className="failure" role="alert">
          <p>{t('home.failed')}</p>
          <button type="button" className="button" onClick={() => onRetry?.()}>
            {t('chat.retry')}
          </button>
        </div>
      )}
      {/* After a failed read the old home is not shown as if it were now. */}
      {status === undefined || load === 'failed' || load === 'locked' ? load === 'idle' && <p className="notice">{t('home.empty')}</p> : renderCard(status)}
    </section>
  ) : null;
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  // Every button sayable (idea 4): saying "Show my home" does what tapping it does, and reads the home once.
  const show = () => {
    if (open) return;
    onShow?.();
    onOpen?.();
    setOpen(true);
  };
  return { button, view, open: show, close };
}
