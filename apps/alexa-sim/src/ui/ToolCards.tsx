import '@cold-reserve/ui-cards/cards.css';
import type { DataOriginValue } from '@cold-reserve/contracts';
import { GuardReceipt, IceCubesCard, PlanCard, PreferencesCard } from '@cold-reserve/ui-cards';
import type { CardSlot, ToolCard } from '../agent/wire.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { t } from './text.js';

// The cards of an answer, rendered straight in the page for now (PR 2a). PR 2b moves them into
// sandboxed ui:// frames through the MCP Apps bridge; the data they receive stays the same.

export interface ToolCardsProps {
  cards: readonly CardSlot[];
  timeZone: string;
  /** Where the home's data comes from, for cards whose tool result carries no origin (preferences). */
  origin?: DataOriginValue;
  /** Touch is the same as voice (plan §11.2 p.1): a card action is said as the next turn. */
  onAsk: (text: string) => void;
}

export function ToolCards({ cards, timeZone, origin, onAsk }: ToolCardsProps) {
  return (
    <div className="tool-cards">
      {cards.map((card, i) => (
        // One boundary per card: a broken card never blanks the answer (error-handling §3).
        <ErrorBoundary key={`${card.tool}-${String(i)}`}>
          {card.tool === 'invalid' ? (
            // Broke its contract (already logged by readCards): a calm message instead of the card.
            <p role="alert">{t('surface.failed')}</p>
          ) : (
            <ToolCardView card={card} timeZone={timeZone} onAsk={onAsk} {...(origin !== undefined && { origin })} />
          )}
        </ErrorBoundary>
      ))}
    </div>
  );
}

function ToolCardView({ card, timeZone, origin, onAsk }: { card: ToolCard; timeZone: string; origin?: DataOriginValue; onAsk: (text: string) => void }) {
  switch (card.tool) {
    case 'plan_comfort':
      return (
        <>
          <PlanCard
            plan={card.result}
            timeZone={timeZone}
            onApply={() => {
              onAsk(t('plan.applyUtterance'));
            }}
            onDismiss={() => {
              onAsk(t('plan.dismissUtterance'));
            }}
          />
          <GuardReceipt plan={card.result} />
        </>
      );
    case 'apply_plan': {
      const { plan, alreadyApplied, advisoryOnly, manualInstructions } = card.result;
      return (
        <>
          <p className="notice" role="status">
            {t(alreadyApplied ? 'plan.alreadyApplied' : 'plan.applied')}
          </p>
          {advisoryOnly && manualInstructions.length > 0 && (
            <ul className="manual" aria-label={t('plan.manual')}>
              {manualInstructions.map((m) => (
                <li key={m.roomId}>{m.text}</li>
              ))}
            </ul>
          )}
          <PlanCard plan={plan} timeZone={timeZone} />
        </>
      );
    }
    case 'get_reserve_outlook':
      return <IceCubesCard outlook={card.result} />;
    case 'get_preferences':
      // No Save yet: set_preferences goes through the MCP Apps bridge in PR 2b; voice works meanwhile.
      return <PreferencesCard view={card.result} {...(origin !== undefined && { origin })} />;
  }
}
