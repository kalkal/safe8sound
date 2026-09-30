import type { ErrorCode, ErrorEnvelope, Result } from '@cold-reserve/contracts';
import type { CardSlot, StatusFacts } from './wire.js';

export interface AskContext {
  /** One id per user turn, propagated to sim-api (error-handling §6). */
  correlationId: string;
  /** Aborted when the user cancels the turn: the adapter rethrows, it does not report a failure. */
  signal?: AbortSignal;
}

export interface AgentAnswer {
  text: string;
  status?: StatusFacts;
  cards?: CardSlot[];
  /** Set when the answer comes from the degraded mode: the code of the failure it replaces. */
  degradedBy?: ErrorCode;
}

/** The port the UI talks to (plan §9.3): ScriptedAgent, RemoteAgent, or the remote one with a scripted fallback. */
export interface Agent {
  ask(question: string, context: AskContext): Promise<Result<AgentAnswer, ErrorEnvelope>>;
}
