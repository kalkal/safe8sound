import type { HomeStatus } from '@cold-reserve/contracts';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { t } from './text.js';

// "Show my home" (#204): the floor plan with the rooms, temperatures, battery, solar and grid, behind one button so the
// screen stays clean. A disclosure, not a dialog: the rest of the page stays usable; Escape closes it and the focus
// goes back to the button.

export interface HomePanelProps {
  status: HomeStatus | undefined;
  /** Draws the home card (a ui:// frame in the simulator). */
  renderCard: (status: HomeStatus) => ReactNode;
  /** Remote mode (#262): the read of the home on demand, while it comes or when it failed. */
  load?: 'idle' | 'loading' | 'failed';
  /** Called each time the panel opens: the remote home is read then. */
  onOpen?: () => void;
  onRetry?: () => void;
}

export function HomePanel({ status, renderCard, load = 'idle', onOpen, onRetry }: HomePanelProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const titleId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    setOpen(false);
    buttonRef.current?.focus();
  };
  return (
    // Escape anywhere in the block (the button or the panel) closes it. Inside the card frame the card has its own keys.
    <div className="home-panel" onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        className="chip-button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        {t(open ? 'home.hide' : 'home.show')}
      </button>
      {open && (
        <section id={panelId} className="home-panel-body" aria-labelledby={titleId}>
          <h2 id={titleId} className="visually-hidden">
            {t('home.title')}
          </h2>
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
          {status === undefined || load === 'failed' ? load === 'idle' && <p className="notice">{t('home.empty')}</p> : renderCard(status)}
        </section>
      )}
    </div>
  );
}
