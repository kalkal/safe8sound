import type { DataOriginValue } from '@cold-reserve/contracts';
import { useEffect, useId, type ReactNode } from 'react';
import { t } from './text.js';

/** LIVE / SIMULATED next to every number (plan §11.1): simulated data is never shown as real. */
export function OriginBadge({ origin }: { origin: DataOriginValue }) {
  return (
    <span className="origin-badge" data-origin={origin} data-testid="origin-badge">
      {origin === 'simulated' && <span aria-hidden="true">≈ </span>}
      {t(origin === 'live' ? 'data.live' : 'data.simulatedBadge')}
    </span>
  );
}

/**
 * Every card: a titled section with its data badge. Inline by default; full screen only when the person asks,
 * for the whole frame through the host (plan §11.2 p.2, #200), never a button that only flips its label.
 */
export function CardShell({ title, origin, children }: { title: string; origin?: DataOriginValue; children: ReactNode }) {
  const titleId = useId();
  return (
    <section className="card" aria-labelledby={titleId}>
      <header className="card-head">
        <h2 id={titleId}>{title}</h2>
        {origin !== undefined && <OriginBadge origin={origin} />}
      </header>
      {children}
    </section>
  );
}

/** The frame's display mode as the host offers it (MCP Apps availableDisplayModes / displayMode). */
export interface DisplayControl {
  readonly canFullscreen: boolean;
  readonly fullscreen: boolean;
  /** Asks the host for the other mode; the host answers with the mode it really set. */
  readonly toggle: () => void;
}

/** One "Full screen" / "Back" for the whole frame; Escape goes back. None when the host cannot show it. */
export function DisplayToggle({ display }: { display: DisplayControl }) {
  const { fullscreen, toggle } = display;
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') toggle();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [fullscreen, toggle]);
  if (!display.canFullscreen) return null;
  return (
    <div className="display-toggle">
      <button type="button" className="card-expand" onClick={toggle}>
        {t(fullscreen ? 'card.back' : 'card.fullScreen')}
      </button>
    </div>
  );
}
