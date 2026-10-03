import { ok, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMachine } from '@xstate/react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type SyntheticEvent } from 'react';
import { fromPromise } from 'xstate';
import type { Agent, AgentAnswer, DemoSession } from '../agent/index.js';
import type { VoiceConfig } from '../config.js';
import { conversationMachine, type AskInput, type AskOutput, type ConversationEvent } from '../machine.js';
import { log, voiceFailureEvent } from '../log.js';
import { useVoice, type StudioVoice } from '../voice/use-voice.js';
import { privacyNotice, voiceNotice } from '../voice/voice-notice.js';
import { AnswerCard } from './AnswerCard.js';
import { DemoCodeGate } from './DemoCodeGate.js';
import { ExampleQuestions } from './ExampleQuestions.js';
import { t } from './text.js';

type TurnResult = Result<AgentAnswer, ErrorEnvelope>;
const turnKey = (turnId: string | null) => ['turn', turnId] as const;

export interface ConversationProps {
  agent: Agent;
  turnBudgetMs: number;
  timeZone: string;
  voice: VoiceConfig;
  /** Remote mode only: without a token the demo code field replaces the question field. */
  session?: DemoSession;
  /** Remote mode only: the replies may be read by the studio voice (Polly, F8d #25). */
  studioVoice?: StudioVoice;
}

export function Conversation({ agent, turnBudgetMs, timeZone, voice: voiceConfig, session, studioVoice }: ConversationProps) {
  const subscribe = useCallback((listener: () => void) => (session ? session.subscribe(listener) : () => undefined), [session]);
  const token = useSyncExternalStore(subscribe, () => session?.token());
  const queryClient = useQueryClient();
  // The voice adapters send machine events; the machine exists only after them, hence the ref.
  const sendRef = useRef<(event: ConversationEvent) => void>(() => undefined);
  const voice = useVoice(
    voiceConfig,
    (event) => {
      sendRef.current(event);
    },
    studioVoice,
  );
  const { recognizer, speaker } = voice;
  // The machine owns the flow; the answer itself stays in the query cache (plan §9.4).
  const machine = useMemo(
    () =>
      conversationMachine.provide({
        actors: {
          askAgent: fromPromise<Result<AskOutput, ErrorEnvelope>, AskInput>(async ({ input, signal }) => {
            const result = await queryClient.query<TurnResult>({
              queryKey: turnKey(input.turnId),
              queryFn: () => agent.ask(input.question, { correlationId: input.turnId, signal }),
              staleTime: Infinity,
              retry: false,
            });
            // The answer text is at most two sentences (plan §11.2 p.10): it is what the voice reads.
            return result.ok ? ok({ speech: result.value.text }) : result;
          }),
        },
        actions: {
          startRecognition: () => recognizer?.start(),
          stopRecognition: () => recognizer?.stop(),
          speak: ({ context }) => speaker?.speak(context.speech ?? '', context.turnId ?? undefined),
          cancelSpeech: () => speaker?.cancel(),
          logVoiceFailure: (_, failure) => {
            log(voiceFailureEvent(failure));
          },
        },
      }),
    [agent, queryClient, recognizer, speaker],
  );
  const [snapshot, send] = useMachine(machine, { input: { replyTimeoutMs: turnBudgetMs, voice: voice.settings } });
  sendRef.current = send;
  const { question, turnId, error, canRetry, micAvailable, speakReplies } = snapshot.context;
  const privacy = privacyNotice({ micAvailable, speakReplies, studioVoice: voice.studioVoice });
  const notice = voiceNotice(snapshot.context);
  const listening = snapshot.matches('listening');
  const speaking = snapshot.matches('speaking');
  const turn = useQuery<TurnResult>({ queryKey: turnKey(turnId), queryFn: skipToken });
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const stopSpeakingRef = useRef<HTMLButtonElement>(null);
  // A valid demo code brings the question field back: the focus goes there (review of #140).
  const hadToken = useRef(token !== undefined);
  useEffect(() => {
    if (session !== undefined && token !== undefined && !hadToken.current) inputRef.current?.focus();
    hadToken.current = token !== undefined;
  }, [session, token]);
  // After Cancel or Retry the clicked button disappears: keep keyboard users on the question field.
  // While the answer is read, the mic is disabled: keep keyboard users on the one control that acts now.
  const speakingNow = snapshot.matches('speaking');
  useEffect(() => {
    const focused = document.activeElement;
    if (speakingNow && (focused === null || focused === document.body || focused === micRef.current)) stopSpeakingRef.current?.focus();
  }, [speakingNow]);
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
        {question !== null && !snapshot.matches('idle') && !listening && <p className="bubble">{question}</p>}
        {listening && (
          <p className="thinking" role="status">
            {t('voice.listening')}
          </p>
        )}
        {notice !== null && !listening && (
          <p className="notice" role="status">
            {t(notice)}
          </p>
        )}
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
          {(snapshot.matches('showingAnswer') || speaking) && turn.data?.ok === true && turnId !== null && (
            <AnswerCard answer={turn.data.value} timeZone={timeZone} turnId={turnId} />
          )}
        </div>
        {/* The row keeps its place even when empty: the form never moves under a finger when the voice starts or stops. */}
        {speakReplies && (
          <div className="voice-row">
            {speaking && (
              <button
                ref={stopSpeakingRef}
                type="button"
                className="link-button"
                onClick={() => {
                  sendAndRefocus({ type: 'CANCEL' });
                }}
              >
                {t('voice.stopSpeaking')}
              </button>
            )}
          </div>
        )}
        {/* A refused demo session is explained by the gate alone, not as a failed answer (review of #140). */}
        {snapshot.matches('failed') && error !== null && error.category !== 'unauthorized' && (
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
      {session !== undefined && token === undefined ? (
        <DemoCodeGate session={session} />
      ) : (
      <form className="ask" onSubmit={onSubmit}>
        <label htmlFor="question">{t('chat.label')}</label>
        <p id="question-hint" className="muted">
          {t('chat.hint')}
        </p>
        <ExampleQuestions
          onPick={(question) => {
            // Only fills the field: the person reads it and presses Ask (never sent by itself).
            setDraft(question);
            inputRef.current?.focus();
          }}
        />
        <div className="ask-row">
          <input
            id="question"
            ref={inputRef}
            name="question"
            autoComplete="off"
            aria-describedby="question-hint"
            placeholder={t('chat.placeholder')}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
          />
          <button type="submit" className="button" disabled={thinking}>
            {t('chat.send')}
          </button>
          {micAvailable && (
            <button
              ref={micRef}
              type="button"
              className="button"
              aria-pressed={listening}
              disabled={thinking || speaking}
              onClick={() => {
                send(listening ? { type: 'CANCEL' } : { type: 'MIC_PRESSED' });
              }}
            >
              {t(listening ? 'voice.stop' : 'voice.speak')}
            </button>
          )}
        </div>
        {voice.browserVoiceNotice && speakReplies && (
          <p className="notice" role="status">
            {t('voice.browserVoice')}
          </p>
        )}
        {privacy !== null && <p className="notice">{t(privacy)}</p>}
      </form>
      )}
    </>
  );
}
