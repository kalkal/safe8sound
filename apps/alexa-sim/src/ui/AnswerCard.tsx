import { homeClock } from '@cold-reserve/ui-cards';
import { useState } from 'react';
import type { AgentAnswer } from '../agent/index.js';
import { OriginBadge } from './OriginBadge.js';
import { t } from './text.js';
import { ToolCards } from './ToolCards.js';

export interface AnswerCardProps {
  answer: AgentAnswer;
  timeZone: string;
  /** The turn that produced the answer: the correlation id of its cards. */
  turnId: string;
}

export function AnswerCard({ answer, timeZone, turnId }: AnswerCardProps) {
  const { status } = answer;
  // #398: on a phone, under a card, the words keep two lines; a touch opens them (CSS shows the button only there).
  const [open, setOpen] = useState(false);
  return (
    <article className="answer" data-testid="answer" data-words-open={open}>
      {answer.degradedBy !== undefined && (
        <p className="notice" role="note">
          {t('chat.degraded')}
        </p>
      )}
      <div className="answer-words">
        <p className="answer-text" id="answer-words-text">
          {answer.text}
        </p>
        {answer.cards !== undefined && (
          <button
            type="button"
            className="answer-more"
            aria-expanded={open}
            aria-controls="answer-words-text"
            onClick={() => {
              setOpen(!open);
            }}
          >
            {t(open ? 'answers.readLess' : 'answers.readAll')}
          </button>
        )}
      </div>
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
      {answer.cards !== undefined && <ToolCards cards={answer.cards} turnId={turnId} />}
    </article>
  );
}
