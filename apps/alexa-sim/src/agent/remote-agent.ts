import {
  CORRELATION_ID_HEADER,
  ProblemDetailsSchema,
  ToolCallReplySchema,
  categoryOf,
  err,
  isRetryableCategory,
  ok,
  toolError,
  type ErrorCode,
  type ErrorEnvelope,
  type Result,
} from '@cold-reserve/contracts';
import { toolErrorResult, type Agent, type AgentAnswer, type ToolCallResult } from './agent.js';
import type { DemoSession } from './demo-session.js';
import { TurnReplySchema, readCards } from './wire.js';

export interface RemoteAgentConfig {
  baseUrl: string;
  /** Explicit timeout for one turn request, from config (error-handling §4). */
  timeoutMs: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** The demo session (#101): its token goes with every request; without it card actions stay off. */
  session?: Pick<DemoSession, 'token' | 'invalidate'>;
}

/** sim-api refused the token: the session is forgotten and the UI asks for the code again. */
const AUTH_FAILURES: ReadonlySet<ErrorCode> = new Set(['missing_token', 'invalid_signature', 'signature_expired']);

// No retry here: sim-api retries its own dependencies, and the conversation machine offers one retry to the user.
export function createRemoteAgent(config: RemoteAgentConfig): Agent {
  const doFetch = config.fetch ?? ((url, init) => fetch(url, init));
  const base = config.baseUrl.replace(/\/$/, '');
  const { session } = config;

  /** One POST to sim-api: the body text, or the failure as an envelope (a caller's cancellation is rethrown). */
  async function post(path: string, body: unknown, correlationId: string, signal?: AbortSignal): Promise<Result<{ status: number; text: string }, ErrorEnvelope>> {
    const token = session?.token();
    if (session && token === undefined) return err(toolError('missing_token', 'Enter the demo code first.'));
    const timeout = AbortSignal.timeout(config.timeoutMs);
    try {
      const response = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CORRELATION_ID_HEADER]: correlationId, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      return ok({ status: response.status, text: await response.text() });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) return err(toolError('agent_timeout', `The assistant did not answer within ${String(config.timeoutMs)} ms.`));
      return err(toolError('agent_unavailable', 'The assistant could not be reached.'));
    }
  }

  function failure(status: number, text: string): ErrorEnvelope {
    const error = parseProblem(status, text);
    if (session && AUTH_FAILURES.has(error.code)) session.invalidate(error.code);
    return error;
  }

  return {
    // Card actions run only with a demo session: sim-api binds them to the visitor's sandbox home.
    canCallTools: session !== undefined,
    callTool: async (name, args, context): Promise<ToolCallResult> => {
      if (!session) return toolErrorResult(toolError('agent_unavailable', "Card actions don't reach the assistant yet: say it instead."));
      const sent = await post('/v1/tools/call', { name, arguments: args }, context.correlationId, context.signal);
      if (!sent.ok) return toolErrorResult(sent.error);
      if (sent.value.status >= 300) return toolErrorResult(failure(sent.value.status, sent.value.text));
      const reply = ToolCallReplySchema.safeParse(parseJson(sent.value.text));
      if (!reply.success) return toolErrorResult(toolError('output_schema_violation', 'The assistant sent a result in an unexpected format.'));
      const { isError, content, structuredContent } = reply.data;
      return { content, ...(isError === undefined ? {} : { isError }), ...(structuredContent === undefined ? {} : { structuredContent }) };
    },
    ask: async (question, context) => {
      const sent = await post('/v1/turns', { question }, context.correlationId, context.signal);
      if (!sent.ok) return sent;
      return sent.value.status < 300 ? parseReply(sent.value.text, context.correlationId) : err(failure(sent.value.status, sent.value.text));
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

function parseProblem(status: number, body: string): ErrorEnvelope {
  const problem = ProblemDetailsSchema.safeParse(parseJson(body));
  if (problem.success) {
    const { code, detail, retryAfterMs } = problem.data;
    const keepRetryAfter = retryAfterMs !== undefined && isRetryableCategory(categoryOf(code));
    return toolError(code, detail, keepRetryAfter ? { retryAfterMs } : {});
  }
  if (status >= 500) return toolError('agent_unavailable', `The assistant service failed (HTTP ${String(status)}).`);
  return toolError('output_schema_violation', `The assistant sent an unexpected HTTP ${String(status)} response.`);
}
