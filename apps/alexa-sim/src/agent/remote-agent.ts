import { ProblemDetailsSchema, categoryOf, err, isRetryableCategory, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { toolErrorResult, type Agent, type AgentAnswer } from './agent.js';
import { TurnReplySchema, readCards } from './wire.js';

export interface RemoteAgentConfig {
  baseUrl: string;
  /** Explicit timeout for one turn request, from config (error-handling §4). */
  timeoutMs: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

// No retry here: sim-api retries its own dependencies, and the conversation machine offers one retry to the user.
export function createRemoteAgent(config: RemoteAgentConfig): Agent {
  const doFetch = config.fetch ?? ((url, init) => fetch(url, init));
  const url = `${config.baseUrl.replace(/\/$/, '')}/v1/turns`;

  return {
    // Card actions are hidden in this mode until sim-api runs them (#55); the refusal is a safety net.
    canCallTools: false,
    // TODO(sim-api, #55): POST the card's tool call once sim-api has a tools endpoint. Until then an honest refusal.
    callTool: () => Promise.resolve(toolErrorResult(toolError('agent_unavailable', "Card actions don't reach the assistant yet: say it instead."))),
    ask: async (question, context) => {
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const signal = context.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
      let response: Response;
      let body: string;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-correlation-id': context.correlationId },
          body: JSON.stringify({ question }),
          signal,
        });
        body = await response.text();
      } catch (error) {
        if (context.signal?.aborted) throw error;
        if (timeout.aborted) return err(toolError('agent_timeout', `The assistant did not answer within ${String(config.timeoutMs)} ms.`));
        return err(toolError('agent_unavailable', 'The assistant could not be reached.'));
      }
      return response.ok ? parseReply(body, context.correlationId) : parseProblem(response.status, body);
    },
  };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function parseReply(body: string, correlationId: string): Result<AgentAnswer, ErrorEnvelope> {
  const parsed = TurnReplySchema.safeParse(parseJson(body));
  if (!parsed.success) return err(toolError('output_schema_violation', 'The assistant sent a reply in an unexpected format.'));
  const { text, status, cards } = parsed.data;
  const slots = readCards(cards, { correlationId });
  return ok({ text, ...(status !== undefined && { status }), ...(slots !== undefined && { cards: slots }) });
}

function parseProblem(status: number, body: string): Result<never, ErrorEnvelope> {
  const problem = ProblemDetailsSchema.safeParse(parseJson(body));
  if (problem.success) {
    const { code, detail, retryAfterMs } = problem.data;
    const keepRetryAfter = retryAfterMs !== undefined && isRetryableCategory(categoryOf(code));
    return err(toolError(code, detail, keepRetryAfter ? { retryAfterMs } : {}));
  }
  if (status >= 500) return err(toolError('agent_unavailable', `The assistant service failed (HTTP ${String(status)}).`));
  return err(toolError('output_schema_violation', `The assistant sent an unexpected HTTP ${String(status)} response.`));
}
