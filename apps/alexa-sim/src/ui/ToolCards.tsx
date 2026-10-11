import { useId, useState } from 'react';
import type { CardSlot } from '../agent/wire.js';
import { CardFrame, kindOf } from '../host/CardFrame.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { t } from './text.js';

// The cards of an answer, each in its own sandboxed ui:// frame (MCP Apps). Actions inside a card are
// tool calls through the host; the page never renders card content itself.
// Pages instead of scrolling (owner, 10 Oct): one card at a time, a tab per card named by what it shows. Every frame
// stays loaded (hidden, not removed), so switching never reloads a card or loses what it was doing.

function tabLabel(card: CardSlot): string {
  const kind = card.tool === 'invalid' ? undefined : kindOf(card.tool);
  return kind === undefined ? t('cardTab.other') : t(`cardTab.${kind}`);
}

export function ToolCards({ cards, turnId }: { cards: readonly CardSlot[]; turnId: string }) {
  const [shown, setShown] = useState(0);
  const id = useId();
  const tabs = cards.length > 1;
  return (
    <div className="tool-cards">
      {tabs && (
        <div className="card-tabs" role="tablist" aria-label={t('cardTab.list')}>
          {cards.map((card, i) => (
            <button
              key={`${card.tool}-${String(i)}`}
              type="button"
              role="tab"
              id={`${id}-tab-${String(i)}`}
              aria-selected={i === shown}
              aria-controls={`${id}-panel-${String(i)}`}
              className="chip-button"
              onClick={() => {
                setShown(i);
              }}
            >
              {tabLabel(card)}
            </button>
          ))}
        </div>
      )}
      {cards.map((card, i) => (
        <div
          key={`${card.tool}-${String(i)}`}
          {...(tabs ? { role: 'tabpanel', id: `${id}-panel-${String(i)}`, 'aria-labelledby': `${id}-tab-${String(i)}`, hidden: i !== shown } : {})}
        >
          {/* One boundary per card: a broken card never blanks the answer (error-handling §3). */}
          <ErrorBoundary>
            {card.tool === 'invalid' ? (
              // Broke its contract (already logged by readCards): a calm message instead of the card.
              <p role="alert">{t('surface.failed')}</p>
            ) : (
              <CardFrame card={card} turnId={turnId} />
            )}
          </ErrorBoundary>
        </div>
      ))}
    </div>
  );
}
