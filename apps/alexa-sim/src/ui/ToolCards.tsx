import type { CardSlot } from '../agent/wire.js';
import { CardFrame } from '../host/CardFrame.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { t } from './text.js';

// The cards of an answer, each in its own sandboxed ui:// frame (MCP Apps). Actions inside a card are
// tool calls through the host; the page never renders card content itself.

export function ToolCards({ cards, turnId }: { cards: readonly CardSlot[]; turnId: string }) {
  return (
    <div className="tool-cards">
      {cards.map((card, i) => (
        // One boundary per card: a broken card never blanks the answer (error-handling §3).
        <ErrorBoundary key={`${card.tool}-${String(i)}`}>
          {card.tool === 'invalid' ? (
            // Broke its contract (already logged by readCards): a calm message instead of the card.
            <p role="alert">{t('surface.failed')}</p>
          ) : (
            <CardFrame card={card} turnId={turnId} />
          )}
        </ErrorBoundary>
      ))}
    </div>
  );
}
