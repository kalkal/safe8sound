import type { DataOriginValue } from '@cold-reserve/contracts';
import { useId, useState, type ReactNode } from 'react';
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

/** Every card: inline by default, expanded only when the person asks (plan §11.2 p.2). */
export function CardShell({ title, origin, children }: { title: string; origin?: DataOriginValue; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const titleId = useId();
  return (
    <section className="card" aria-labelledby={titleId} data-expanded={expanded}>
      <header className="card-head">
        <h2 id={titleId}>{title}</h2>
        {origin !== undefined && <OriginBadge origin={origin} />}
        <button
          type="button"
          className="card-expand"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded(!expanded);
          }}
        >
          {t(expanded ? 'card.collapse' : 'card.expand')}
        </button>
      </header>
      {children}
    </section>
  );
}
