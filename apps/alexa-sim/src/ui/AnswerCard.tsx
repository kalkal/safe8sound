import { homeClock } from '@cold-reserve/ui-cards';
import { useState } from 'react';
import type { AgentAnswer } from '../agent/index.js';
import { OriginBadge } from './OriginBadge.js';
import { t } from './text.js';
import { ToolCards } from './ToolCards.js';

export interface AnswerCardProps {
  answer: AgentAnswer;
  timeZone: string;
  /** Set when the answer was given before the simulated clock last moved: its "HH:MM" (owner, 18 Oct). */
  earlierAt?: string;
  /** The turn that produced the answer: the correlation id of its cards. */
  turnId: string;
}

export function AnswerCard({ answer, timeZone, turnId, earlierAt }: AnswerCardProps) {
  const { status } = answer;
  // An empty list of cards is no card: the words then keep the screen (never an empty Echo screen after an answer).
  const cards = answer.cards !== undefined && answer.cards.length > 0 ? answer.cards : undefined;
  // #398: on a phone, under a card, the words keep two lines; a touch opens them (CSS shows the button only there).
  const [open, setOpen] = useState(false);
  return (
    <article className="answer" data-testid="answer" data-words-open={open}>
      {/* Read with the answer by screen readers; the eye sees the same words as a pill in the header band. */}
      {earlierAt !== undefined && (
        <p className="visually-hidden" data-testid="answer-when" data-earlier="true">
          {t('answers.earlier', { time: earlierAt })}
        </p>
      )}
      {answer.degradedBy !== undefined && (
        <p className="notice" role="note">
          {t('chat.degraded')}
        </p>
      )}
      <div className="answer-words">
        <p className="answer-text" id="answer-words-text" data-testid="answer-caption">
          {answer.text}
        </p>
        {cards !== undefined && (
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
      {cards !== undefined && <ToolCards cards={cards} turnId={turnId} />}
    </article>
  );
}
