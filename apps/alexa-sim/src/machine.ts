import { err, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { assign, fromPromise, setup } from 'xstate';

// The conversation flow (plan §9.3). Text only for now: F8d adds `listening` and `speaking`
// with the same state and event names as spike S5 (TEXT_SUBMITTED, CANCEL, thinking).
// The machine governs the flow only; the answer data lives in the TanStack Query cache,
// keyed by turn id (plan §9.4: "XState + TanStack Query").

export interface ConversationInput {
  /** Budget for a whole turn, from config. */
  replyTimeoutMs: number;
}

export interface AskInput {
  question: string;
  turnId: string;
}

export interface ConversationContext extends ConversationInput {
  question: string | null;
  turnId: string | null;
  error: ErrorEnvelope | null;
  /** One user retry per question, and only for transient errors (error-handling §3, §4). */
  canRetry: boolean;
  retried: boolean;
}

export type ConversationEvent =
  | { type: 'TEXT_SUBMITTED'; text: string; turnId: string }
  | { type: 'RETRY'; turnId: string }
  | { type: 'CANCEL' }
  | { type: 'DISMISS' };

export const conversationMachine = setup({
  types: {
    context: {} as ConversationContext,
    events: {} as ConversationEvent,
    input: {} as ConversationInput,
  },
  actions: {
    newQuestion: assign(({ event }) =>
      event.type === 'TEXT_SUBMITTED' ? { question: event.text.trim(), turnId: event.turnId, error: null, retried: false, canRetry: false } : {},
    ),
    fail: assign(({ context }, error: ErrorEnvelope) => ({ error, canRetry: error.retryable && !context.retried })),
  },
  actors: {
    askAgent: fromPromise<Result<null, ErrorEnvelope>, AskInput>(() =>
      Promise.resolve(err(toolError('invalid_config', 'No agent is configured.'))),
    ),
  },
  guards: {
    hasText: ({ event }) => event.type === 'TEXT_SUBMITTED' && event.text.trim().length > 0,
    canRetry: ({ context }) => context.canRetry,
  },
  delays: {
    replyTimeout: ({ context }) => context.replyTimeoutMs,
  },
}).createMachine({
  id: 'conversation',
  initial: 'idle',
  context: ({ input }) => ({ ...input, question: null, turnId: null, error: null, canRetry: false, retried: false }),
  states: {
    idle: {
      on: { TEXT_SUBMITTED: { guard: 'hasText', target: 'thinking', actions: 'newQuestion' } },
    },
    thinking: {
      invoke: {
        src: 'askAgent',
        input: ({ context }) => ({ question: context.question ?? '', turnId: context.turnId ?? '' }),
        onDone: [
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
    showingAnswer: {
      on: {
        TEXT_SUBMITTED: { guard: 'hasText', target: 'thinking', actions: 'newQuestion' },
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
        DISMISS: 'idle',
      },
    },
  },
});
