import type { CardKind } from '@cold-reserve/ui-cards';
import type { CardSlot } from '../agent/wire.js';
import { CardFrame, kindOf } from '../host/CardFrame.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { t } from './text.js';

// The cards of an answer, each in its own sandboxed ui:// frame (MCP Apps). Actions inside a card are
// tool calls through the host; the page never renders card content itself.
// One card per answer (owner, 19 Oct, B; it replaces the tabs of 10 Oct): a real Echo Show shows one inline card with
// an answer (Alexa+ add-on design guide), so ours shows the most important one, the safe room when the answer has it,
// else the first. The others stay loaded (hidden, not removed), so asking for one ("Show the plan") never reloads it.

const kindOfSlot = (card: CardSlot): CardKind | undefined => (card.tool === 'invalid' ? undefined : kindOf(card.tool));

/** The card an answer opens on: the safe room when there is one (the person the home protects), else the first. */
function primaryIndex(cards: readonly CardSlot[]): number {
  const room = cards.findIndex((card) => kindOfSlot(card) === 'storm');
  return room === -1 ? 0 : room;
}

function shownIndex(cards: readonly CardSlot[], show: CardKind | undefined): number {
  const asked = show === undefined ? -1 : cards.findIndex((card) => kindOfSlot(card) === show);
  return asked === -1 ? primaryIndex(cards) : asked;
}

/** The one card of the answer on screen (one card per answer, owner 19 Oct B): the asked one, else the main one. */
export function shownCard<T extends CardSlot>(cards: readonly T[], show: CardKind | undefined): T | undefined {
  return cards[shownIndex(cards, show)];
}

/** The kinds of the answer's cards not on screen, in order, each once: what "Show the plan" and the like can bring. */
export function otherKinds(cards: readonly CardSlot[], show: CardKind | undefined): CardKind[] {
  const shown = shownIndex(cards, show);
  const kinds = cards.flatMap((card, i) => {
    const kind = kindOfSlot(card);
    return i === shown || kind === undefined ? [] : [kind];
  });
  return [...new Set(kinds)];
}

export function ToolCards({ cards, turnId, show }: { cards: readonly CardSlot[]; turnId: string; show?: CardKind | undefined }) {
  const shown = shownIndex(cards, show);
  return (
    <div className="tool-cards">
      {cards.map((card, i) => (
        <div key={`${card.tool}-${String(i)}`} data-card-slot="" hidden={i !== shown}>
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
