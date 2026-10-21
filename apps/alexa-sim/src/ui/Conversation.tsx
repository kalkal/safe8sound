import { ok, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { getLocale } from '@cold-reserve/i18n';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMachine } from '@xstate/react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { fromPromise } from 'xstate';
import type { Agent, AgentAnswer, DemoSession } from '../agent/index.js';
import type { AskContext } from '../agent/agent.js';
import type { CardSlot } from '../agent/wire.js';
import type { VoiceConfig } from '../config.js';
import { conversationMachine, type AskInput, type AskOutput, type ConversationEvent } from '../machine.js';
import { log, voiceFailureEvent } from '../log.js';
import { useVoice, type StudioVoice } from '../voice/use-voice.js';
import { useSlowTurn } from './slow-turn.js';
import { privacyNotice, voiceNotice } from '../voice/voice-notice.js';
import { pagerSayable, runScreenCommand, type ScreenCommand } from './screen-commands.js';
import { AnswerCard } from './AnswerCard.js';
import { otherKinds, shownCard } from './ToolCards.js';
import type { CardKind } from '@cold-reserve/ui-cards';
import { addAnswer, answerMoment, backToStart, currentAnswer, emptyHistory, historyPosition, stepAnswer } from './answer-history.js';
import { backAction, stepOf } from './steps.js';
import { AnswerPager } from './AnswerPager.js';
import { DemoCodeGate } from './DemoCodeGate.js';
import { DemoOverlay } from './DemoOverlay.js';
import { ExampleQuestions, type ExampleQuestion } from './ExampleQuestions.js';
import { Spinner } from './Spinner.js';
import { t } from './text.js';
import { failedTurnText, mayHaveGoneThrough, type FailedTurnFinding } from './failed-turn.js';
import { useIdleReturn } from './idle-return.js';
import { VoiceBar, voiceBarState } from './VoiceBar.js';
import type { ScreenState } from '../surface/contract.js';

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
  onAnswer?: (answer: AgentAnswer, turnId: string) => void;
  /** The example buttons for the home's state (#268): storm examples with the grid down. */
  examples?: readonly ExampleQuestion[];
  /** Every button sayable (idea 4): the header's buttons (home, theme), run when their label is said or typed. */
  commands?: readonly ScreenCommand[];
  /** Three bands (owner, 10 Oct): what the header band shows (title, theme, the home button). */
  head?: ReactNode;
  /** A page of the screen when open (the home, #432 S5 the settings): shown in the content band in place of the answer. */
  pageView?: ReactNode;
  /** The idle screen's own content (the cold reserve clock, owner 11 Oct), under the first screen's hint. */
  idle?: ReactNode;
  /** Back (idea 5) with a page open: closes it, back to what was under it. */
  onClosePage?: () => void;
  /** The steps (idea 5): the turns whose plan was applied from its card, at "Confirm". */
  /** An answer that asked whose plan is now applied, by tap or by voice (host/card-actions). */
  answeredOnCard?: (turnId: string, cards: readonly CardSlot[] | undefined) => boolean;
  /**
   * Runs before the question goes to the agent (time pack, 12 Oct): "Power cut" first makes the simulated grid go
   * down. A failure fails the turn, honestly, and Retry runs it again.
   */
  prepareTurn?: (question: string, context: AskContext) => Promise<Result<void, ErrorEnvelope>>;
  /**
   * #477: after a turn that failed in a way that may have let its tools run (a timeout, a busy service), reads the home and
   * the phone again (never the model) and says what it finds; without it the failure keeps its words.
   */
  readAfterFailure?: (turnId: string) => Promise<FailedTurnFinding>;
  /**
   * The simulated time now (local ISO, the home's zone), when there is a simulated clock: each answer is labelled with
   * the time it came, and marked as earlier once the clock has moved on (owner, 18 Oct).
   */
  simNow?: string;
  /** Counts the plays of the simulated day: a new one clears the answers of the last. */
  playthrough?: number;
  /**
   * #432 S6: the idle screen comes back this long after an answer (or the home) was last touched, once the voice is
   * done and no plan waits for its choice (config.idleReturnMs). Absent: the answer stays until Back.
   */
  idleReturnMs?: number;
  /** What the screen shows (idle, a turn on its way, an answer): the layout dims the sky behind an answer. */
  onScreen?: (screen: ScreenState) => void;
  /** #432 S6: where the judges' bar is drawn, outside the device (the question field, Ask, Speak, the answers' pager). */
  actionsHost?: Element | null;
  /** H (owner, 19 Oct): set to a function that asks a question as if the person had said it ("Power cut" in the panel). */
  askRef?: RefObject<((question: string) => void) | null>;
  /** The first line of the idle screen (a greeting); without it, what to ask. */
  greeting?: ReactNode;
  /** The demo closed for today (the day's turns used up, closedNoticeOf): said in the greeting's place, questions off. */
  closedNotice?: string;
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
  pageView,
  idle,
  onClosePage,
  answeredOnCard,
  prepareTurn,
  readAfterFailure,
  simNow,
  playthrough = 0,
  idleReturnMs,
  onScreen,
  actionsHost,
  askRef,
  greeting,
  closedNotice,
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
  // #477: what the reads after a failed turn found, for that turn only (a new turn starts from the words of today).
  const [afterFailure, setAfterFailure] = useState<{ turnId: string; finding: FailedTurnFinding } | undefined>(undefined);
  // Only a timeout or a busy service may have let the tools run (review of #491): a refusal or a wait is never read again.
  const failedTurn = snapshot.matches('failed') && error !== null && mayHaveGoneThrough(error.code) && turnId !== null ? turnId : undefined;
  const readAfterFailureRef = useRef(readAfterFailure);
  readAfterFailureRef.current = readAfterFailure;
  useEffect(() => {
    const read = readAfterFailureRef.current;
    if (failedTurn === undefined || read === undefined) return undefined;
    let wanted = true;
    void read(failedTurn).then((finding) => {
      if (wanted) setAfterFailure({ turnId: failedTurn, finding });
    });
    return () => {
      wanted = false;
    };
  }, [failedTurn]);
  const privacy = privacyNotice({ micAvailable, speakReplies, studioVoice: voice.studioVoice });
  const notice = voiceNotice(snapshot.context);
  const listening = snapshot.matches('listening');
  // Follow Up (#432 S6): the mic listens again after a spoken answer; the answer stays on screen meanwhile.
  const followUp = snapshot.matches('followUp');
  const micOpen = listening || followUp;
  // After Speak and while the assistant thinks, the question box and Ask are off (owner report, 20 Oct): no half-typed
  // text goes out over a spoken question. The box stays read-only, not disabled, so it keeps the focus. Follow Up is not
  // locked: typing in its listen-again window closes the mic and the keyboard wins.
  const askLocked = listening || snapshot.matches('thinking');
  const speaking = snapshot.matches('speaking');
  // Read by the reset of a new play: only a reading voice is stopped, never a turn on its way ("Power cut" restarts the day).
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  const turn = useQuery<TurnResult>({ queryKey: turnKey(turnId), queryFn: skipToken });
  const answer = turn.data?.ok === true ? turn.data.value : undefined;
  useEffect(() => {
    if (answer !== undefined && turnId !== null) onAnswer?.(answer, turnId);
  }, [answer, onAnswer, turnId]);
  // One answer at a time (owner's choice, 10 Oct): every answered turn is kept for Previous / Next.
  const [history, setHistory] = useState(emptyHistory);
  // The simulated time of each answer (owner, 18 Oct): once the clock moves on, an older answer says it is earlier.
  const answeredAt = useRef(new Map<string, string>());
  useEffect(() => {
    if (answer === undefined || turnId === null) return;
    if (simNowRef.current !== undefined && !answeredAt.current.has(turnId)) answeredAt.current.set(turnId, simNowRef.current);
    setHistory((previous) => addAnswer(previous, turnId));
  }, [answer, turnId]);
  // A new play of the day (Restart, a new scenario or place): the answers of the last one describe another day, so
  // they go and the first screen comes back (owner, 18 Oct).
  const lastPlay = useRef(playthrough);
  useEffect(() => {
    if (lastPlay.current === playthrough) return;
    lastPlay.current = playthrough;
    // The voice stops reading an answer of the last play.
    if (speakingRef.current) sendRef.current({ type: 'CANCEL' });
    answeredAt.current.clear();
    setHistory(emptyHistory);
  }, [playthrough]);
  const shownTurn = currentAnswer(history);
  const moment = shownTurn === undefined ? undefined : answerMoment(answeredAt.current.get(shownTurn), simNow);
  const shown = useQuery<TurnResult>({ queryKey: turnKey(shownTurn ?? null), queryFn: skipToken });
  const position = historyPosition(history);
  // One card per answer (owner, 19 Oct, B): the card asked for on screen ("Show the plan"), for the answer it was asked on.
  const [cardAsked, setCardAsked] = useState<{ turnId: string; kind: CardKind } | undefined>(undefined);
  const cardShown = cardAsked !== undefined && cardAsked.turnId === shownTurn ? cardAsked.kind : undefined;
  // Previous / Next: every answer comes back on its main card.
  useEffect(() => {
    setCardAsked(undefined);
  }, [shownTurn]);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
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

  const closed = closedNotice !== undefined;
  // When the questions turn off, the focus would drop to the page (the field it was on is disabled): it goes to the
  // notice instead, which a screen reader then reads. Only when the notice cannot take the focus (no welcome line on
  // screen) does a status region say it, so it is never said twice (reviews of #482).
  const welcomeRef = useRef<HTMLParagraphElement>(null);
  const [noticeFocused, setNoticeFocused] = useState(false);
  useEffect(() => {
    if (!closed) return;
    welcomeRef.current?.focus();
    setNoticeFocused(welcomeRef.current !== null && document.activeElement === welcomeRef.current);
  }, [closed]);
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (askLocked || closed) return;
    // Inside the tap: the answer arrives later, and the browser only reads it aloud if the page was unlocked here.
    voice.unlock();
    const turnId = crypto.randomUUID();
    if (!runCommand(draft, turnId)) send({ type: 'TEXT_SUBMITTED', text: draft, turnId });
    setDraft('');
  };
  // H (owner, 19 Oct): the judges' "Power cut" asks for the person, inside the judge's tap (so the voice may answer).
  useEffect(() => {
    if (askRef === undefined) return undefined;
    askRef.current = (question: string) => {
      voice.unlock();
      send({ type: 'TEXT_SUBMITTED', text: question, turnId: crypto.randomUUID() });
    };
    return () => {
      askRef.current = null;
    };
  }, [askRef, voice, send]);
  const thinking = snapshot.matches('thinking');
  // A turn on its way (or failed): the content band shows it, not an older answer.
  const busy = thinking || listening || snapshot.matches('failed');
  const pageShown = pageView !== undefined && pageView !== null && !busy;
  // Nothing asked yet, or Back from the first answer (idea 5): the content band explains what to ask.
  const firstScreen = !busy && !pageShown && shownTurn === undefined && (history.turns.length > 0 || !snapshot.matches('speaking'));
  // Before Start (remote mode without a token) the bar holds the demo code gate, not the examples: the first line says
  // what to do first and never points to examples that are not there (owner, 20 Oct).
  const gated = session !== undefined && token === undefined;
  const step = (delta: 1 | -1) => {
    setHistory((previous) => stepAnswer(previous, delta));
  };
  // "Back" always there and the path of the steps (idea 5).
  const pageOpen = pageView !== undefined && pageView !== null;
  // The step is what is on screen: the card shown, not the answer's other cards behind "Show the plan" (review of #458:
  // a storm answer's hidden plan kept the idle screen from coming back).
  const cardOnScreen = busy || shown.data?.ok !== true ? undefined : shownCard(shown.data.value.cards ?? [], cardShown);
  // Its question was answered on a card, or by voice in a later turn: the steps say Confirm, the words say Done.
  const shownAnswered = shownTurn !== undefined && shown.data?.ok === true && answeredOnCard?.(shownTurn, shown.data.value.cards) === true;
  const where = stepOf({
    // A page in the content band is the home step (the settings page too: no step of its own).
    homeOpen: pageShown,
    cards: cardOnScreen === undefined ? undefined : [cardOnScreen],
    applied: shownAnswered,
  });
  const back = backAction({ thinking, failed: snapshot.matches('failed'), pageOpen, answerIndex: history.index });
  const goBack =
    back === undefined
      ? undefined
      : () => {
          // The voice stops reading the answer that is leaving the screen (review of #350).
          if (snapshot.matches('speaking')) send({ type: 'CANCEL' });
          if (back === 'close_page') onClosePage?.();
          else if (back === 'previous_answer') step(-1);
          else setHistory(backToStart);
        };
  // The answer pager's buttons, while it is on screen, then the header's (home, theme) from the frame.
  commandsRef.current = [
    ...(pagerSayable({ thinking, failed: snapshot.matches('failed'), pageOpen, hasAnswers: position !== undefined })
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
    // The other cards of the answer on screen, said or typed ("Show the plan"); the home has its own panel ("Show my home").
    ...(busy || pageShown || shownTurn === undefined || shown.data?.ok !== true
      ? []
      : otherKinds(shown.data.value.cards ?? [], cardShown)
          .filter((kind) => kind !== 'home')
          .map((kind) => ({
            id: `card_${kind}`,
            phrases: [t(`cardShow.${kind}`)],
            run: () => {
              setCardAsked({ turnId: shownTurn, kind });
            },
          }))),
    ...commands,
  ];
  // A cold start can take most of the browser's wait (#270): after a while the screen says so, honestly.
  const slowTurn = useSlowTurn(thinking);
  // What the screen shows, for the layout (#432 S6): the sky is the whole screen at rest, dimmed behind the rest.
  const screenState: ScreenState = firstScreen ? 'idle' : busy ? 'busy' : 'answer';
  useEffect(() => {
    onScreen?.(screenState);
  }, [onScreen, screenState]);
  // Back to the idle screen a while after the answer (or the home) was last touched (#432 S6): never while the voice
  // reads it, nor while a plan waits for "Apply plan" or "Not now" (its step is the plan, not yet confirmed).
  useIdleReturn({
    active: idleReturnMs !== undefined && (pageShown || (!busy && shownTurn !== undefined)) && !speaking && !followUp && !replaying && where !== 'plan',
    delayMs: idleReturnMs ?? 0,
    onReturn: () => {
      if (pageOpen) onClosePage?.();
      setHistory(backToStart);
    },
  });

  // The judges' bar under the Echo (#432 S6, owner I = a): where an answer is among the others, whether it is from
  // an earlier time, the examples, the question field, Ask and Speak. A real Echo Show has none of them on its screen,
  // so they are drawn outside the device, in the host the page gives (actionsHost); without one, under the screen.
  const actions = (
    <>
      {(!busy && !pageShown && ((moment?.earlier === true && shown.data?.ok === true) || position !== undefined)) && (
        <div className="ask-bar-where">
          {/* An answer given before the clock last moved says so, with its simulated time (the answer carries the same
              words for screen readers, AnswerCard). */}
          {moment?.earlier === true && shown.data?.ok === true && (
            <p className="answer-when" aria-hidden="true">
              {t('answers.earlier', { time: moment.time })}
            </p>
          )}
          {position !== undefined && (
            <AnswerPager
              position={position}
              onStep={(delta) => {
                setHistory((previous) => stepAnswer(previous, delta));
              }}
            />
          )}
        </div>
      )}
        {gated ? (
          <DemoCodeGate session={session} />
        ) : (
        <form className="ask band-actions" data-slot="actions" data-testid="slot-actions" onSubmit={onSubmit}>
          {/* The label is said, not shown (the placeholder and Ask show it); the hint is the field's description. */}
          <label htmlFor="question" className="visually-hidden">
            {t('chat.label')}
          </label>
          <p id="question-hint" className="visually-hidden">
            {t('chat.hint')}
          </p>
          <div className="try-row">
            <span className="try-saying" aria-hidden="true">
              {t('examples.trySaying')}
            </span>
            <ExampleQuestions
            disabled={closed}
            {...(examples === undefined ? {} : { examples })}
            onPick={(question) => {
              // Only fills the field: the person reads it and presses Ask (never sent by itself). Not while the box is off
              // (review of #469); in Follow Up a pick is like typing: the mic closes and the keyboard wins.
              if (askLocked) return;
              if (followUp) send({ type: 'CANCEL' });
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
              placeholder={t(listening ? 'voice.listening' : 'chat.placeholder')}
              readOnly={askLocked}
              aria-disabled={askLocked}
              disabled={closed}
              value={draft}
              onChange={(e) => {
                // Typing in Follow Up's listen-again window closes the mic: the keyboard wins.
                if (followUp) send({ type: 'CANCEL' });
                setDraft(e.target.value);
              }}
            />
            <button type="submit" className="button button-quiet" aria-busy={thinking} disabled={askLocked || closed}>
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
                aria-pressed={micOpen}
                aria-busy={thinking}
                disabled={thinking || speaking || replaying || closed}
                onClick={() => {
                  voice.unlock();
                  send(micOpen ? { type: 'CANCEL' } : { type: 'MIC_PRESSED' });
                }}
              >
                {t(micOpen ? 'voice.stop' : 'voice.speak')}
              </button>
            )}
          </div>
        </form>
        )}
    </>
  );
  // Under the bar, small: the voice notices, and for the judges why one card shows (owner, 19 Oct, B).
  const severalCards = !busy && !pageShown && shown.data?.ok === true && (shown.data.value.cards?.length ?? 0) > 1;
  const notes = (
    <div className="ask-bar-notes">
      {severalCards && <p className="notice ask-bar-one-card">{t('demoControls.oneCard')}</p>}
      {voice.browserVoiceNotice && speakReplies && (
        <p className="notice" role="status">
          {t('voice.browserVoice')}
        </p>
      )}
      {privacy !== null && <p className="notice privacy-notice">{t(privacy)}</p>}
    </div>
  );
  return (
    <div className="bands">
      <div className="band-head" data-slot="head" data-testid="slot-head">
        {head}
      </div>
      <section className="conversation band-content" data-slot="content" data-testid="slot-content">
        {/* The person's own words are never written on the screen (#432 S6): a real Echo Show shows Alexa's answer
            (captions), not what was said (Amazon Help "Turn On Captioning"). */}
        {/* Listening, Follow Up included: the bar's light in words for screen readers (VoiceBar). */}
        {micOpen && (
          <p className="thinking" role="status">
            {t('voice.listening')}
          </p>
        )}
        {/* "It's on the screen" is only true while the answer is (review of #498): at rest the silent voice's notice and its
            Listen go with the answer. */}
        {notice !== null && !listening && !(notice === 'voice.silent' && firstScreen) && (
          <p className="notice" role="status">
            {t(notice)}
          </p>
        )}
        {notice === 'voice.silent' && !listening && !busy && !firstScreen && shown.data?.ok === true && (
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
        <p className="visually-hidden" role="status">
          {noticeFocused ? '' : (closedNotice ?? '')}
        </p>
        <div aria-live="polite">
          {!busy && !pageShown && shown.data?.ok === true && shownTurn !== undefined && (
            // One answer, one state: Previous / Next never carry a tab or a frame from another answer.
            <AnswerCard key={shownTurn} answer={shown.data.value} timeZone={timeZone} turnId={shownTurn} show={cardShown} applied={shownAnswered} {...(moment?.earlier === true ? { earlierAt: moment.time } : {})} />
          )}
        </div>
        {pageShown && pageView}
        {firstScreen && (
          <p ref={welcomeRef} className="welcome" data-testid="welcome-hint" {...(closed ? { tabIndex: -1 } : {})}>
            {closedNotice ?? greeting ?? t(gated ? 'chat.hintBeforeStart' : 'chat.hint')}
          </p>
        )}
        {firstScreen && idle}
        {/* A refused demo session is explained by the gate alone, not as a failed answer (review of #140). */}
        {snapshot.matches('failed') && error !== null && error.category !== 'unauthorized' && (
          <div className="failure" role="alert">
            <p>{error.retryable ? failedTurnText(afterFailure?.turnId === turnId ? afterFailure.finding : { kind: 'nothing' }, error.code) : t('chat.errorOther')}</p>
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
      {actionsHost === undefined || actionsHost === null ? (
        <>
          {actions}
          {notes}
        </>
      ) : (
        createPortal(
          <>
            <div className="ask-bar">{actions}</div>
            {notes}
          </>,
          actionsHost,
        )
      )}
      {/* Listening, thinking, ready: the light at the bottom of the screen, always (#432 S6). */}
      <VoiceBar state={voiceBarState({ listening, thinking, speaking, followUp })} />
      {demo && <DemoOverlay said={question !== null && !snapshot.matches('idle') && !listening ? question : null} />}
    </div>
  );
}
