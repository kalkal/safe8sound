import type { DataOriginValue } from '@cold-reserve/contracts';
import { homeClock } from '@cold-reserve/ui-cards';
import type { AgentAnswer } from '../agent/index.js';
import { OriginBadge } from './OriginBadge.js';
import { t } from './text.js';
import { ToolCards } from './ToolCards.js';

export interface AnswerCardProps {
  answer: AgentAnswer;
  timeZone: string;
  origin?: DataOriginValue;
  onAsk: (text: string) => void;
}

export function AnswerCard({ answer, timeZone, origin, onAsk }: AnswerCardProps) {
  const { status } = answer;
  return (
    <article className="answer" data-testid="answer">
      {answer.degradedBy !== undefined && (
        <p className="notice" role="note">
          {t('chat.degraded')}
        </p>
      )}
      <p className="answer-text">{answer.text}</p>
      {status !== undefined && (
        <dl className="facts">
          <div className="fact">
            <dt>{t('status.battery')}</dt>
            <dd>
              <span className="fact-value" data-testid="battery-soc">
                {status.batterySocPct}%
              </span>
              <OriginBadge origin={status.origin.energy} />
              <span className="fact-asof">{t('data.asOf', { time: homeClock(status.ts, timeZone) })}</span>
            </dd>
          </div>
        </dl>
      )}
      {answer.cards !== undefined && <ToolCards cards={answer.cards} timeZone={timeZone} onAsk={onAsk} {...(origin !== undefined && { origin })} />}
    </article>
  );
}
