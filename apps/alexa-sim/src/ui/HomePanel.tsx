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
}

export function HomePanel({ status, renderCard }: HomePanelProps) {
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
          {status === undefined ? <p className="notice">{t('home.empty')}</p> : renderCard(status)}
        </section>
      )}
    </div>
  );
}
