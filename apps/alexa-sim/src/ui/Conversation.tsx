import { ok, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMachine } from '@xstate/react';
import { useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { fromPromise } from 'xstate';
import type { Agent, AgentAnswer } from '../agent/index.js';
import { conversationMachine, type AskInput } from '../machine.js';
import { AnswerCard } from './AnswerCard.js';
import { t } from './text.js';

type TurnResult = Result<AgentAnswer, ErrorEnvelope>;
const turnKey = (turnId: string | null) => ['turn', turnId] as const;

export function Conversation({ agent, turnBudgetMs }: { agent: Agent; turnBudgetMs: number }) {
  const queryClient = useQueryClient();
  // The machine owns the flow; the answer itself stays in the query cache (plan §9.4).
  const machine = useMemo(
    () =>
      conversationMachine.provide({
        actors: {
          askAgent: fromPromise<Result<null, ErrorEnvelope>, AskInput>(async ({ input, signal }) => {
            const result = await queryClient.query<TurnResult>({
              queryKey: turnKey(input.turnId),
              queryFn: () => agent.ask(input.question, { correlationId: input.turnId, signal }),
              staleTime: Infinity,
              retry: false,
            });
            return result.ok ? ok(null) : result;
          }),
        },
      }),
    [agent, queryClient],
  );
  const [snapshot, send] = useMachine(machine, { input: { replyTimeoutMs: turnBudgetMs } });
  const { question, turnId, error, canRetry } = snapshot.context;
  const turn = useQuery<TurnResult>({ queryKey: turnKey(turnId), queryFn: skipToken });
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // After Cancel or Retry the clicked button disappears: keep keyboard users on the question field.
  const sendAndRefocus = (event: Parameters<typeof send>[0]) => {
    send(event);
    inputRef.current?.focus();
  };

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    send({ type: 'TEXT_SUBMITTED', text: draft, turnId: crypto.randomUUID() });
    setDraft('');
  };
  const thinking = snapshot.matches('thinking');

  return (
    <>
      <section className="conversation">
        {question !== null && !snapshot.matches('idle') && <p className="bubble">{question}</p>}
        {thinking && (
          <p className="thinking" role="status">
            {t('chat.thinking')}{' '}
            <button
              type="button"
              className="link-button"
              onClick={() => {
                sendAndRefocus({ type: 'CANCEL' });
              }}
            >
              {t('chat.cancel')}
            </button>
          </p>
        )}
        {/* Status and alert announce themselves; the answer needs a live region that exists before it appears. */}
        <div aria-live="polite">
          {snapshot.matches('showingAnswer') && turn.data?.ok === true && <AnswerCard answer={turn.data.value} />}
        </div>
        {snapshot.matches('failed') && error !== null && (
          <div className="failure" role="alert">
            <p>{t(error.retryable ? 'chat.errorTransient' : 'chat.errorOther')}</p>
            {canRetry && (
              <button
                type="button"
                className="button"
                onClick={() => {
                  sendAndRefocus({ type: 'RETRY', turnId: crypto.randomUUID() });
                }}
              >
                {t('chat.retry')}
              </button>
            )}
          </div>
        )}
      </section>
      <form className="ask" onSubmit={onSubmit}>
        <label htmlFor="question">{t('chat.label')}</label>
        <div className="ask-row">
          <input
            id="question"
            ref={inputRef}
            name="question"
            autoComplete="off"
            placeholder={t('chat.placeholder')}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
          />
          <button type="submit" className="button" disabled={thinking}>
            {t('chat.send')}
          </button>
        </div>
      </form>
    </>
  );
}
