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

/** The MCP CallToolResult shape a card receives: tool errors are values (isError + the envelope). */
// A type alias, not an interface: the SDK's CallToolResult has an index signature.
export type ToolCallResult = {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

export const toolErrorResult = (envelope: ErrorEnvelope): ToolCallResult => ({
  isError: true,
  content: [{ type: 'text', text: envelope.message }],
  structuredContent: envelope,
});

/** The port the UI talks to (plan §9.3): ScriptedAgent, RemoteAgent, or the remote one with a scripted fallback. */
export interface Agent {
  /** Whether card actions can run: the host announces serverTools to the cards only then. */
  readonly canCallTools: boolean;
  ask(question: string, context: AskContext): Promise<Result<AgentAnswer, ErrorEnvelope>>;
  /** A card action (MCP Apps tools/call through the host), already checked by the host. */
  callTool(name: string, args: Record<string, unknown>, context: AskContext): Promise<ToolCallResult>;
}
