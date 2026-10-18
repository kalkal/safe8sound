import { ok, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { getLocale } from '@cold-reserve/i18n';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMachine } from '@xstate/react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type SyntheticEvent } from 'react';
import { fromPromise } from 'xstate';
import type { Agent, AgentAnswer, DemoSession } from '../agent/index.js';
import type { AskContext } from '../agent/agent.js';
import type { VoiceConfig } from '../config.js';
import { conversationMachine, type AskInput, type AskOutput, type ConversationEvent } from '../machine.js';
import { log, voiceFailureEvent } from '../log.js';
import { useVoice, type StudioVoice } from '../voice/use-voice.js';
import { useSlowTurn } from './slow-turn.js';
import { privacyNotice, voiceNotice } from '../voice/voice-notice.js';
import { pagerSayable, runScreenCommand, type ScreenCommand } from './screen-commands.js';
import { AnswerCard } from './AnswerCard.js';
import { addAnswer, answerMoment, backToStart, currentAnswer, emptyHistory, historyPosition, stepAnswer } from './answer-history.js';
import { StepNav } from './StepNav.js';
import { backAction, stepOf } from './steps.js';
import { AnswerPager } from './AnswerPager.js';
import { DemoCodeGate } from './DemoCodeGate.js';
import { DemoOverlay } from './DemoOverlay.js';
import { ExampleQuestions, type ExampleQuestion } from './ExampleQuestions.js';
import { Spinner } from './Spinner.js';
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
  /** Demo mode for recording the video (`?demo=1`): "You said" caption and the light bar. */
  demo?: boolean;
  /** Each answer as it arrives: the frame reads its cards for the sky. */
  onAnswer?: (answer: AgentAnswer) => void;
  /** The example buttons for the home's state (#268): storm examples with the grid down. */
  examples?: readonly ExampleQuestion[];
  /** Every button sayable (idea 4): the header's buttons (home, theme), run when their label is said or typed. */
  commands?: readonly ScreenCommand[];
  /** Three bands (owner, 10 Oct): what the header band shows (title, theme, the home button). */
  head?: ReactNode;
  /** The home, when open: shown in the content band in place of the answer. */
  homeView?: ReactNode;
  /** The idle screen's own content (the cold reserve clock, owner 11 Oct), under the first screen's hint. */
  idle?: ReactNode;
  /** Back (idea 5) with the home open: closes it, back to what was under it. */
  onCloseHome?: () => void;
  /** The steps (idea 5): the turns whose plan was applied from its card, at "Confirm". */
  appliedTurns?: ReadonlySet<string>;
  /**
   * Runs before the question goes to the agent (time pack, 12 Oct): "Power cut" first makes the simulated grid go
   * down. A failure fails the turn, honestly, and Retry runs it again.
   */
  prepareTurn?: (question: string, context: AskContext) => Promise<Result<void, ErrorEnvelope>>;
  /**
   * The simulated time now (local ISO, the home's zone), when there is a simulated clock: each answer is labelled with
   * the time it came, and marked as earlier once the clock has moved on (owner, 18 Oct).
   */
  simNow?: string;
  /** Counts the plays of the simulated day: a new one clears the answers of the last. */
  playthrough?: number;
}

export function Conversation({
  agent,
  turnBudgetMs,
  timeZone,
  voice: voiceConfig,
  session,
  studioVoice,
  demo = false,
  onAnswer,
  examples,
  commands = [],
  head,
  homeView,
  idle,
  onCloseHome,
  appliedTurns,
  prepareTurn,
  simNow,
  playthrough = 0,
}: ConversationProps) {
  // Read when a turn starts: the machine is built once, the frame may hand a new function at each render.
  const prepareRef = useRef(prepareTurn);
  prepareRef.current = prepareTurn;
  // Read when an answer arrives: "Power cut" moves the clock before the answer, so the answer gets the time it speaks of.
  const simNowRef = useRef(simNow);
  simNowRef.current = simNow;
  const subscribe = useCallback((listener: () => void) => (session ? session.subscribe(listener) : () => undefined), [session]);
  const token = useSyncExternalStore(subscribe, () => session?.token());
  const queryClient = useQueryClient();
  // The voice adapters send machine events; the machine exists only after them, hence the ref.
  const sendRef = useRef<(event: ConversationEvent) => void>(() => undefined);
  // The buttons on screen now, by their labels (idea 4); set at each render, read when something is said or typed.
  const commandsRef = useRef<readonly ScreenCommand[]>([]);
  /** A button's label, said or typed, taps that button: true when it did, so it is not asked to the agent. */
  const runCommand = (text: string, turnId: string): boolean => runScreenCommand(text, turnId, commandsRef.current, log);
  const voice = useVoice(
    voiceConfig,
    (event) => {
      if (event.type === 'SPEECH_RECOGNISED' && runCommand(event.transcript, event.turnId)) {
        sendRef.current({ type: 'CANCEL' });
        return;
      }
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
              queryFn: async () => {
                const context = { correlationId: input.turnId, signal, locale: getLocale() };
                const prepared = await prepareRef.current?.(input.question, context);
                if (prepared !== undefined && !prepared.ok) return prepared;
                return agent.ask(input.question, context);
              },
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
  // Read by the reset of a new play: only a reading voice is stopped, never a turn on its way ("Power cut" restarts the day).
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  const turn = useQuery<TurnResult>({ queryKey: turnKey(turnId), queryFn: skipToken });
  const answer = turn.data?.ok === true ? turn.data.value : undefined;
  useEffect(() => {
    if (answer !== undefined) onAnswer?.(answer);
  }, [answer, onAnswer]);
  // One answer at a time (owner's choice, 10 Oct): every answered turn is kept, with its question, for Previous / Next.
  const [history, setHistory] = useState(emptyHistory);
  const questions = useRef(new Map<string, string>());
  // The simulated time of each answer (owner, 18 Oct): once the clock moves on, an older answer says it is earlier.
  const answeredAt = useRef(new Map<string, string>());
  useEffect(() => {
    if (answer === undefined || turnId === null) return;
    if (question !== null) questions.current.set(turnId, question);
    if (simNowRef.current !== undefined && !answeredAt.current.has(turnId)) answeredAt.current.set(turnId, simNowRef.current);
    setHistory((previous) => addAnswer(previous, turnId));
  }, [answer, turnId, question]);
  // A new play of the day (Restart, a new scenario or place): the answers of the last one describe another day, so
  // they go and the first screen comes back (owner, 18 Oct).
  const lastPlay = useRef(playthrough);
  useEffect(() => {
    if (lastPlay.current === playthrough) return;
    lastPlay.current = playthrough;
    // The voice stops reading an answer of the last play.
    if (speakingRef.current) sendRef.current({ type: 'CANCEL' });
    questions.current.clear();
    answeredAt.current.clear();
    setHistory(emptyHistory);
  }, [playthrough]);
  const shownTurn = currentAnswer(history);
  const moment = shownTurn === undefined ? undefined : answerMoment(answeredAt.current.get(shownTurn), simNow);
  const shown = useQuery<TurnResult>({ queryKey: turnKey(shownTurn ?? null), queryFn: skipToken });
  const position = historyPosition(history);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Back disabled under the keyboard focus (review of #350): the focus goes to the question field.
  const focusQuestion = useCallback(() => {
    inputRef.current?.focus();
  }, []);
  // Listen reads the answer again, outside the machine: the mic waits until it is over.
  const [replaying, setReplaying] = useState(false);
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
    // Inside the tap: the answer arrives later, and the browser only reads it aloud if the page was unlocked here.
    voice.unlock();
    const turnId = crypto.randomUUID();
    if (!runCommand(draft, turnId)) send({ type: 'TEXT_SUBMITTED', text: draft, turnId });
    setDraft('');
  };
  const thinking = snapshot.matches('thinking');
  // A turn on its way (or failed): the content band shows it, not an older answer.
  const busy = thinking || listening || snapshot.matches('failed');
  const homeShown = homeView !== undefined && homeView !== null && !busy;
  // Nothing asked yet, or Back from the first answer (idea 5): the content band explains what to ask.
  const firstScreen = !busy && !homeShown && shownTurn === undefined && (history.turns.length > 0 || !snapshot.matches('speaking'));
  const step = (delta: 1 | -1) => {
    setHistory((previous) => stepAnswer(previous, delta));
  };
  // "Back" always there and the path of the steps (idea 5).
  const homeOpen = homeView !== undefined && homeView !== null;
  const where = stepOf({
    homeOpen: homeShown,
    cards: busy || shown.data?.ok !== true ? undefined : shown.data.value.cards,
    applied: shownTurn !== undefined && appliedTurns?.has(shownTurn) === true,
  });
  const back = backAction({ thinking, failed: snapshot.matches('failed'), homeOpen, answerIndex: history.index });
  const goBack =
    back === undefined
      ? undefined
      : () => {
          // The voice stops reading the answer that is leaving the screen (review of #350).
          if (snapshot.matches('speaking')) send({ type: 'CANCEL' });
          if (back === 'close_home') onCloseHome?.();
          else if (back === 'previous_answer') step(-1);
          else setHistory(backToStart);
        };
  // The answer pager's buttons, while it is on screen, then the header's (home, theme) from the frame.
  commandsRef.current = [
    ...(pagerSayable({ thinking, failed: snapshot.matches('failed'), homeOpen: homeView !== undefined && homeView !== null, hasAnswers: position !== undefined })
      ? [
          {
            id: 'previous_answer',
            phrases: [t('answers.previous'), t('answers.previousShort')],
            run: () => {
              step(-1);
            },
          },
          {
            id: 'next_answer',
            phrases: [t('answers.next'), t('answers.nextShort')],
            run: () => {
              step(1);
            },
          },
        ]
      : []),
    ...(goBack === undefined ? [] : [{ id: 'back', phrases: [t('nav.back'), t('nav.backUtterance')], run: goBack }]),
    ...commands,
  ];
  // A cold start can take most of the browser's wait (#270): after a while the screen says so, honestly.
  const slowTurn = useSlowTurn(thinking);

  return (
    <div className="bands">
      <div className="band-head" data-slot="head" data-testid="slot-head">
        <StepNav step={where} onBack={goBack} onFocusLost={focusQuestion} />
        {head}
        {/* An answer given before the clock last moved says so, with its simulated time; an answer of now needs no
            label (the clock under the screen says the time). The pill in the header band is what the eye sees, on a row
            the header already has; the answer itself carries the same words for screen readers (AnswerCard). */}
        {!busy && !homeShown && moment?.earlier === true && shown.data?.ok === true && (
          <p className="answer-when" aria-hidden="true">
            {t('answers.earlier', { time: moment.time })}
          </p>
        )}
        {/* Where we are among the answers: in the header band, so the content band is the answer's alone. */}
        {!busy && !homeShown && position !== undefined && (
          <AnswerPager
            position={position}
            onStep={(delta) => {
              setHistory((previous) => stepAnswer(previous, delta));
            }}
          />
        )}
      </div>
      <section className="conversation band-content" data-slot="content" data-testid="slot-content">
        {/* While a turn runs, its question; otherwise the question of the answer on screen. */}
        {busy && question !== null && !listening && <p className="bubble">{question}</p>}
        {!busy && !homeShown && shownTurn !== undefined && questions.current.has(shownTurn) && <p className="bubble">{questions.current.get(shownTurn)}</p>}
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
        {notice === 'voice.silent' && !listening && !busy && shown.data?.ok === true && (
          <button
            type="button"
            className="button button-quiet listen-button"
            aria-label={t('voice.listenLabel')}
            onClick={() => {
              if (shown.data?.ok !== true) return;
              setReplaying(true);
              voice.replay(shown.data.value.text, () => {
                setReplaying(false);
              });
            }}
          >
            <span aria-hidden="true">🔊</span> {t('voice.listen')}
          </button>
        )}
        {slowTurn && (
          <p className="notice" role="status">
            {t('chat.stillWorking')}
          </p>
        )}
        {thinking && (
          <p className="thinking" role="status">
            <Spinner /> {t('chat.thinking')}{' '}
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
          {!busy && !homeShown && shown.data?.ok === true && shownTurn !== undefined && (
            // One answer, one state: Previous / Next never carry a tab or a frame from another answer.
            <AnswerCard key={shownTurn} answer={shown.data.value} timeZone={timeZone} turnId={shownTurn} {...(moment?.earlier === true ? { earlierAt: moment.time } : {})} />
          )}
        </div>
        {homeShown && homeView}
        {firstScreen && (
          <p id="question-hint" className="welcome" data-testid="welcome-hint">
            {t('chat.hint')}
          </p>
        )}
        {firstScreen && idle}
        {/* A refused demo session is explained by the gate alone, not as a failed answer (review of #140). */}
        {snapshot.matches('failed') && error !== null && error.category !== 'unauthorized' && (
          <div className="failure" role="alert">
            <p>{t(error.code === 'agent_timeout' ? 'chat.errorTimeout' : error.retryable ? 'chat.errorTransient' : 'chat.errorOther')}</p>
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
      <form className="ask band-actions" data-slot="actions" data-testid="slot-actions" onSubmit={onSubmit}>
        {/* Three bands: the label is said, not shown (the placeholder and Ask show it); the hint is the first
            screen's content, and once answers come it stays only as the field's description. */}
        <label htmlFor="question" className="visually-hidden">
          {t('chat.label')}
        </label>
        {!firstScreen && (
          <p id="question-hint" className="visually-hidden">
            {t('chat.hint')}
          </p>
        )}
        <div className="try-row">
          <span className="try-saying" aria-hidden="true">
            {t('examples.trySaying')}
          </span>
          <ExampleQuestions
          {...(examples === undefined ? {} : { examples })}
          onPick={(question) => {
            // Only fills the field: the person reads it and presses Ask (never sent by itself).
            setDraft(question);
            inputRef.current?.focus();
          }}
          />
        </div>
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
          <button type="submit" className="button button-quiet" aria-busy={thinking} disabled={thinking}>
            {t('chat.send')}
          </button>
          {/* Three bands: stopping the voice is an action in this row, in the place of Speak (disabled while the answer
              is read anyway), so it never pushes the card out of the band nor squeezes the field. */}
          {speakReplies && speaking && (
            <button
              ref={stopSpeakingRef}
              type="button"
              className="button button-quiet voice-button"
              aria-label={t('voice.stopSpeaking')}
              onClick={() => {
                sendAndRefocus({ type: 'CANCEL' });
              }}
            >
              {t('voice.stopSpeakingShort')}
            </button>
          )}
          {micAvailable && !speaking && (
            <button
              ref={micRef}
              type="button"
              className="button button-quiet voice-button"
              aria-pressed={listening}
              aria-busy={thinking}
              disabled={thinking || speaking || replaying}
              onClick={() => {
                voice.unlock();
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
        {privacy !== null && <p className="notice privacy-notice">{t(privacy)}</p>}
      </form>
      )}
      {demo && <DemoOverlay said={question !== null && !snapshot.matches('idle') && !listening ? question : null} speaking={speaking} />}
    </div>
  );
}
