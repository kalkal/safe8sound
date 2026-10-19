import { err, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { assign, fromPromise, setup } from 'xstate';

// The conversation flow (plan §9.3): idle → listening → thinking → speaking → showingAnswer, with the
// shape of spike S5. Forbidden by construction: speaking while listening, listening while speaking.
// The machine governs the flow only; the answer data lives in the TanStack Query cache, keyed by
// turn id (plan §9.4: "XState + TanStack Query"). The only answer text it holds is what it speaks.

/** Voice failures the person hears about; UI-only, they never cross a boundary. */
export type VoiceErrorCode =
  | 'mic_permission_denied'
  | 'no_speech'
  | 'audio_capture_failed'
  | 'recognition_network'
  | 'language_not_supported'
  | 'recognition_failed'
  | 'listening_timeout'
  | 'speech_synthesis_failed'
  | 'speech_start_missing'
  | 'speech_end_missing';

/** Every voice threshold comes from config. */
export interface VoiceSettings {
  micAvailable: boolean;
  /** Read each answer aloud (the Echo Show surface). */
  speakReplies: boolean;
  listenTimeoutMs: number;
  /** Follow Up (#432 S6): after a spoken answer to a spoken question, listen again this long (0: never). */
  followUpMs: number;
  /** No audio within this time → the answer stays on screen, silent. */
  speakStartTimeoutMs: number;
  /** Safety net for engines that never end: base + per character of the reply. */
  speakTimeoutBaseMs: number;
  speakTimeoutPerCharMs: number;
}

/** Without voice settings the machine is text only: listening and speaking are unreachable. */
const NO_VOICE: VoiceSettings = {
  micAvailable: false,
  speakReplies: false,
  listenTimeoutMs: 0,
  followUpMs: 0,
  speakStartTimeoutMs: 0,
  speakTimeoutBaseMs: 0,
  speakTimeoutPerCharMs: 0,
};

export interface ConversationInput {
  /** Budget for a whole turn, from config. */
  replyTimeoutMs: number;
  voice?: VoiceSettings;
}

export interface AskInput {
  question: string;
  turnId: string;
}

/** What the flow needs from an answer: the words to speak, if any (≤ 2 sentences, plan §11.2 p.10). */
export interface AskOutput {
  speech?: string | undefined;
}

export interface ConversationContext extends VoiceSettings {
  replyTimeoutMs: number;
  question: string | null;
  turnId: string | null;
  error: ErrorEnvelope | null;
  /** One user retry per question, and only for transient errors (error-handling §3, §4). */
  canRetry: boolean;
  retried: boolean;
  /** The words being spoken for the current answer. */
  speech: string | null;
  voiceError: VoiceErrorCode | null;
  /** Consecutive failed voice attempts: one reprompt, then text (plan §11.2 p.10). */
  voiceFailures: number;
  suggestText: boolean;
  /** The question was said, not typed: only then does Follow Up listen again after the answer. */
  spokenQuestion: boolean;
}

export type ConversationEvent =
  | { type: 'TEXT_SUBMITTED'; text: string; turnId: string }
  | { type: 'MIC_PRESSED' }
  | { type: 'SPEECH_RECOGNISED'; transcript: string; turnId: string }
  | { type: 'RECOGNITION_ENDED' }
  | { type: 'RECOGNITION_FAILED'; code: VoiceErrorCode }
  | { type: 'SPEAKING_STARTED' }
  | { type: 'SPEAKING_ENDED' }
  | { type: 'SPEAKING_FAILED' }
  | { type: 'RETRY'; turnId: string }
  | { type: 'CANCEL' }
  | { type: 'DISMISS' };

/** A voice failure as the log sees it: the code and where it happened, never the words. */
export interface VoiceFailure {
  code: VoiceErrorCode;
  phase: 'listening' | 'speaking';
  /** The turn whose answer could not be read; none while listening (the turn starts with the words). */
  turnId: string | null;
}

const VOICE_FAILURES_BEFORE_TEXT = 2;
/** No way to listen any more: the mic button goes away and text stays. */
const MIC_LOST: ReadonlySet<VoiceErrorCode> = new Set(['mic_permission_denied', 'language_not_supported', 'audio_capture_failed']);

const speechOf = (output: Result<AskOutput, ErrorEnvelope>): string => (output.ok ? (output.value.speech?.trim() ?? '') : '');

export const conversationMachine = setup({
  types: {
    context: {} as ConversationContext,
    events: {} as ConversationEvent,
    input: {} as ConversationInput,
  },
  actions: {
    newQuestion: assign(({ event }) => {
      // A new question clears the last voice notice; the failure count (and the text suggestion) stays.
      const fresh = { error: null, retried: false, canRetry: false, speech: null, voiceError: null };
      if (event.type === 'TEXT_SUBMITTED') return { ...fresh, question: event.text.trim(), turnId: event.turnId, spokenQuestion: false };
      if (event.type === 'SPEECH_RECOGNISED') return { ...fresh, question: event.transcript.trim(), turnId: event.turnId, spokenQuestion: true };
      return {};
    }),
    fail: assign(({ context }, error: ErrorEnvelope) => ({ error, canRetry: error.retryable && !context.retried })),
    voiceFail: assign(({ context }, code: VoiceErrorCode) => {
      const voiceFailures = context.voiceFailures + 1;
      const micLost = MIC_LOST.has(code);
      return {
        voiceError: code,
        voiceFailures,
        micAvailable: micLost ? false : context.micAvailable,
        suggestText: micLost || voiceFailures >= VOICE_FAILURES_BEFORE_TEXT,
      };
    }),
    // A spoken answer that failed is still on screen: not a failure of the person's voice.
    speechFail: assign((_, code: VoiceErrorCode) => ({ voiceError: code })),
    voiceTurnDone: assign(({ context }) => ({ voiceFailures: 0, voiceError: null, suggestText: !context.micAvailable })),
    // Side effects, injected by the page (browser or Polly adapters, the logger) or by tests.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- typed no-op: the page injects the logger
    logVoiceFailure: (_, _failure: VoiceFailure) => undefined,
    startRecognition: () => undefined,
    stopRecognition: () => undefined,
    speak: () => undefined,
    cancelSpeech: () => undefined,
  },
  actors: {
    askAgent: fromPromise<Result<AskOutput, ErrorEnvelope>, AskInput>(() =>
      Promise.resolve(err(toolError('invalid_config', 'No agent is configured.'))),
    ),
  },
  guards: {
    hasText: ({ event }) => event.type === 'TEXT_SUBMITTED' && event.text.trim().length > 0,
    hasTranscript: ({ event }) => event.type === 'SPEECH_RECOGNISED' && event.transcript.trim().length > 0,
    micAvailable: ({ context }) => context.micAvailable,
    canRetry: ({ context }) => context.canRetry,
    followUp: ({ context }) => context.spokenQuestion && context.micAvailable && context.followUpMs > 0,
  },
  delays: {
    replyTimeout: ({ context }) => context.replyTimeoutMs,
    listenTimeout: ({ context }) => context.listenTimeoutMs,
    followUpTimeout: ({ context }) => context.followUpMs,
    speakStartTimeout: ({ context }) => context.speakStartTimeoutMs,
    speakTimeout: ({ context }) => context.speakTimeoutBaseMs + context.speakTimeoutPerCharMs * (context.speech?.length ?? 0),
  },
}).createMachine({
  id: 'conversation',
  initial: 'idle',
  context: ({ input }) => {
    const voice = input.voice ?? NO_VOICE;
    return {
      ...voice,
      replyTimeoutMs: input.replyTimeoutMs,
      question: null,
      turnId: null,
      error: null,
      canRetry: false,
      retried: false,
      speech: null,
      voiceError: null,
      voiceFailures: 0,
      suggestText: !voice.micAvailable,
      spokenQuestion: false,
    };
  },
  states: {
    idle: {
      on: {
        TEXT_SUBMITTED: { guard: 'hasText', target: 'thinking', actions: 'newQuestion' },
        MIC_PRESSED: { guard: 'micAvailable', target: 'listening' },
      },
    },
    listening: {
      entry: [assign({ voiceError: null }), 'startRecognition'],
      exit: 'stopRecognition',
      after: {
        listenTimeout: {
          target: 'idle',
          actions: [
            { type: 'voiceFail', params: 'listening_timeout' },
            { type: 'logVoiceFailure', params: { code: 'listening_timeout', phase: 'listening', turnId: null } },
          ],
        },
      },
      on: {
        SPEECH_RECOGNISED: { guard: 'hasTranscript', target: 'thinking', actions: 'newQuestion' },
        RECOGNITION_ENDED: {
          target: 'idle',
          actions: [{ type: 'voiceFail', params: 'no_speech' }, { type: 'logVoiceFailure', params: { code: 'no_speech', phase: 'listening', turnId: null } }],
        },
        RECOGNITION_FAILED: {
          target: 'idle',
          actions: [
            { type: 'voiceFail', params: ({ event }) => event.code },
            { type: 'logVoiceFailure', params: ({ event }) => ({ code: event.code, phase: 'listening' as const, turnId: null }) },
          ],
        },
        TEXT_SUBMITTED: { guard: 'hasText', target: 'thinking', actions: 'newQuestion' },
        CANCEL: 'idle',
      },
    },
    thinking: {
      invoke: {
        src: 'askAgent',
        input: ({ context }) => ({ question: context.question ?? '', turnId: context.turnId ?? '' }),
        onDone: [
          {
            guard: ({ context, event }) => context.speakReplies && speechOf(event.output) !== '',
            target: 'speaking',
            actions: assign(({ event }) => ({ speech: speechOf(event.output) })),
          },
          { guard: ({ event }) => event.output.ok, target: 'showingAnswer' },
          {
            target: 'failed',
            actions: {
              type: 'fail',
              params: ({ event }) => (event.output.ok ? toolError('unexpected_error', 'Unreachable.') : event.output.error),
            },
          },
        ],
        onError: { target: 'failed', actions: { type: 'fail', params: () => toolError('unexpected_error', 'Something went wrong while answering.') } },
      },
      after: {
        replyTimeout: { target: 'failed', actions: { type: 'fail', params: () => toolError('agent_timeout', 'The answer took too long.') } },
      },
      on: { CANCEL: 'idle' },
    },
    // The answer is on screen while it is spoken; the mic waits until the voice is done.
    speaking: {
      entry: 'speak',
      exit: 'cancelSpeech',
      after: {
        speakTimeout: {
          target: 'showingAnswer',
          actions: [
            { type: 'speechFail', params: 'speech_end_missing' },
            { type: 'logVoiceFailure', params: ({ context }) => ({ code: 'speech_end_missing' as const, phase: 'speaking' as const, turnId: context.turnId }) },
          ],
        },
      },
      initial: 'waitingForAudio',
      states: {
        // A network voice offline neither starts nor fails: it just hangs (spike S5, Chrome 153).
        waitingForAudio: {
          after: {
            speakStartTimeout: {
              target: '#conversation.showingAnswer',
              actions: [
                { type: 'speechFail', params: 'speech_start_missing' },
                { type: 'logVoiceFailure', params: ({ context }) => ({ code: 'speech_start_missing' as const, phase: 'speaking' as const, turnId: context.turnId }) },
              ],
            },
          },
          on: { SPEAKING_STARTED: 'audible' },
        },
        audible: {},
      },
      on: {
        SPEAKING_ENDED: [
          { guard: 'followUp', target: 'followUp', actions: 'voiceTurnDone' },
          { target: 'showingAnswer', actions: 'voiceTurnDone' },
        ],
        SPEAKING_FAILED: {
          target: 'showingAnswer',
          actions: [
            { type: 'speechFail', params: 'speech_synthesis_failed' },
            { type: 'logVoiceFailure', params: ({ context }) => ({ code: 'speech_synthesis_failed' as const, phase: 'speaking' as const, turnId: context.turnId }) },
          ],
        },
        TEXT_SUBMITTED: { guard: 'hasText', target: 'thinking', actions: 'newQuestion' },
        CANCEL: 'showingAnswer',
      },
    },
    // Follow Up (#432 S6; Amazon Help "How Follow Up Mode Works on Alexa+"): after a spoken answer to a spoken question
    // the mic listens again without the wake word, for followUpMs (8 s, our choice: Amazon gives no number). Silence,
    // a failed recognition, Cancel or a tap on the mic end it quietly: it was never asked for, so no voice notice.
    followUp: {
      entry: 'startRecognition',
      exit: 'stopRecognition',
      after: { followUpTimeout: 'showingAnswer' },
      on: {
        SPEECH_RECOGNISED: { guard: 'hasTranscript', target: 'thinking', actions: 'newQuestion' },
        RECOGNITION_ENDED: 'showingAnswer',
        RECOGNITION_FAILED: 'showingAnswer',
        TEXT_SUBMITTED: { guard: 'hasText', target: 'thinking', actions: 'newQuestion' },
        MIC_PRESSED: 'showingAnswer',
        CANCEL: 'showingAnswer',
        DISMISS: 'idle',
      },
    },
    showingAnswer: {
      on: {
        TEXT_SUBMITTED: { guard: 'hasText', target: 'thinking', actions: 'newQuestion' },
        MIC_PRESSED: { guard: 'micAvailable', target: 'listening' },
        DISMISS: 'idle',
      },
    },
    failed: {
      on: {
        RETRY: {
          guard: 'canRetry',
          target: 'thinking',
          actions: assign(({ event }) => ({ turnId: event.turnId, error: null, retried: true, canRetry: false })),
        },
        TEXT_SUBMITTED: { guard: 'hasText', target: 'thinking', actions: 'newQuestion' },
        MIC_PRESSED: { guard: 'micAvailable', target: 'listening' },
        DISMISS: 'idle',
      },
    },
  },
});

export type TopState = 'idle' | 'listening' | 'followUp' | 'thinking' | 'speaking' | 'showingAnswer' | 'failed';

/** The top-level state name (`speaking` has substates). */
export function topState(snapshot: { value: unknown }): TopState {
  const value = snapshot.value;
  return (typeof value === 'string' ? value : Object.keys(value as object)[0]) as TopState;
}
