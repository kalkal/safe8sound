import { assign, fromPromise, setup } from 'xstate';

/** Stable error codes of the voice flow (candidates for `packages/contracts`). */
export type VoiceErrorCode =
  | 'mic_permission_denied'
  | 'no_speech'
  | 'audio_capture_failed'
  | 'recognition_network'
  | 'language_not_supported'
  | 'recognition_failed'
  | 'listening_timeout'
  | 'reply_timeout'
  | 'reply_failed'
  | 'speech_synthesis_failed'
  | 'speech_start_missing'
  | 'speech_end_missing';

/** Every threshold comes from config, never from the machine. */
export interface VoiceConfig {
  micAvailable: boolean;
  listenTimeoutMs: number;
  replyTimeoutMs: number;
  /** No `onstart` within this time → give up on audio, keep the reply on screen. */
  speakStartTimeoutMs: number;
  /** Safety net for engines that never fire `end`: base + per character of the reply. */
  speakTimeoutBaseMs: number;
  speakTimeoutPerCharMs: number;
}

export interface VoiceContext extends VoiceConfig {
  transcript: string | null;
  reply: string | null;
  error: VoiceErrorCode | null;
  /** Consecutive failed voice attempts; the second one suggests typing instead. */
  failures: number;
  suggestText: boolean;
}

export type VoiceEvent =
  | { type: 'MIC_PRESSED' }
  | { type: 'TEXT_SUBMITTED'; text: string }
  | { type: 'SPEECH_RECOGNISED'; transcript: string }
  | { type: 'RECOGNITION_ENDED' }
  | { type: 'RECOGNITION_FAILED'; code: VoiceErrorCode }
  | { type: 'SPEAKING_STARTED' }
  | { type: 'SPEAKING_ENDED' }
  | { type: 'SPEAKING_FAILED' }
  | { type: 'CANCEL' };

const MAX_VOICE_FAILURES_BEFORE_TEXT = 2;

export const voiceMachine = setup({
  types: {
    context: {} as VoiceContext,
    events: {} as VoiceEvent,
    input: {} as VoiceConfig,
  },
  actions: {
    // Side effects are injected by the page (browser adapters) or by tests.
    startRecognition: () => {},
    stopRecognition: () => {},
    speak: () => {},
    cancelSpeech: () => {},
    fail: assign(({ context }, params: { code: VoiceErrorCode }) => {
      const failures = context.failures + 1;
      const micLost = params.code === 'mic_permission_denied' || params.code === 'language_not_supported';
      return {
        error: params.code,
        failures,
        micAvailable: micLost ? false : context.micAvailable,
        suggestText: micLost || failures >= MAX_VOICE_FAILURES_BEFORE_TEXT,
      };
    }),
  },
  actors: {
    getReply: fromPromise<string, { transcript: string }>(async () => {
      throw new Error('getReply must be provided');
    }),
  },
  guards: {
    micAvailable: ({ context }) => context.micAvailable,
    hasText: ({ event }) => event.type === 'TEXT_SUBMITTED' && event.text.trim().length > 0,
    hasTranscript: ({ event }) => event.type === 'SPEECH_RECOGNISED' && event.transcript.trim().length > 0,
  },
  delays: {
    listenTimeout: ({ context }) => context.listenTimeoutMs,
    replyTimeout: ({ context }) => context.replyTimeoutMs,
    speakStartTimeout: ({ context }) => context.speakStartTimeoutMs,
    speakTimeout: ({ context }) => context.speakTimeoutBaseMs + context.speakTimeoutPerCharMs * (context.reply?.length ?? 0),
  },
}).createMachine({
  id: 'voice',
  initial: 'idle',
  context: ({ input }) => ({
    ...input,
    transcript: null,
    reply: null,
    error: null,
    failures: 0,
    suggestText: !input.micAvailable,
  }),
  states: {
    idle: {
      on: {
        MIC_PRESSED: { guard: 'micAvailable', target: 'listening' },
        TEXT_SUBMITTED: {
          guard: 'hasText',
          target: 'thinking',
          actions: assign({ transcript: ({ event }) => event.text.trim(), error: null }),
        },
      },
    },
    listening: {
      entry: [assign({ error: null, transcript: null }), 'startRecognition'],
      exit: 'stopRecognition',
      after: { listenTimeout: { target: 'idle', actions: { type: 'fail', params: { code: 'listening_timeout' } } } },
      on: {
        SPEECH_RECOGNISED: {
          guard: 'hasTranscript',
          target: 'thinking',
          actions: assign({ transcript: ({ event }) => event.transcript.trim() }),
        },
        RECOGNITION_ENDED: { target: 'idle', actions: { type: 'fail', params: { code: 'no_speech' } } },
        RECOGNITION_FAILED: {
          target: 'idle',
          actions: { type: 'fail', params: ({ event }) => ({ code: event.code }) },
        },
        CANCEL: 'idle',
      },
    },
    thinking: {
      invoke: {
        src: 'getReply',
        input: ({ context }) => ({ transcript: context.transcript ?? '' }),
        onDone: { target: 'speaking', actions: assign({ reply: ({ event }) => event.output }) },
        onError: { target: 'idle', actions: { type: 'fail', params: { code: 'reply_failed' } } },
      },
      after: { replyTimeout: { target: 'idle', actions: { type: 'fail', params: { code: 'reply_timeout' } } } },
      on: { CANCEL: 'idle' },
    },
    speaking: {
      entry: 'speak',
      exit: 'cancelSpeech',
      after: { speakTimeout: { target: 'idle', actions: assign({ error: 'speech_end_missing' as const }) } },
      initial: 'waitingForAudio',
      states: {
        // A network voice offline neither starts nor fails: it just hangs (measured in Chrome 153).
        waitingForAudio: {
          after: { speakStartTimeout: { target: '#voice.idle', actions: assign({ error: 'speech_start_missing' as const }) } },
          on: { SPEAKING_STARTED: 'audible' },
        },
        audible: {},
      },
      on: {
        SPEAKING_ENDED: { target: 'idle', actions: assign(({ context }) => ({ failures: 0, suggestText: !context.micAvailable })) },
        SPEAKING_FAILED: { target: 'idle', actions: assign({ error: 'speech_synthesis_failed' as const }) },
        CANCEL: 'idle',
      },
    },
  },
});

export type TopState = 'idle' | 'listening' | 'thinking' | 'speaking';

/** Top-level state name (`speaking` has substates). */
export function topState(snapshot: { value: unknown }): TopState {
  const v = snapshot.value;
  return (typeof v === 'string' ? v : Object.keys(v as object)[0]) as TopState;
}
