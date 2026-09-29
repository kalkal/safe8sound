import type { AgentAnswer } from '../agent/index.js';
import { OriginBadge } from './OriginBadge.js';
import { homeClock, t } from './text.js';

export function AnswerCard({ answer }: { answer: AgentAnswer }) {
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
              <span className="fact-asof">{t('data.asOf', { time: homeClock(status.ts) })}</span>
            </dd>
          </div>
        </dl>
      )}
    </article>
  );
}
