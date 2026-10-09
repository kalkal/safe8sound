import { ProblemDetailsSchema, TurnFailureSchema, TurnReplySchema, categoryOf, err, isRetryableCategory, ok, toolError, type ErrorCategory, type ErrorCode, type ErrorEnvelope, type Result, type TurnReply } from '@cold-reserve/contracts';
import type { ErrorLine, TurnAgentPort } from '../handler.js';

/**
 * The agent over HTTP in the AgentCore runtime shape (POST /invocations, approved in #101): the local
 * agent entry now; at S2 a SigV4 AgentCore adapter takes this port's place.
 */
export function httpTurnAgent(opts: {
  url: string;
  invokeToken: string;
  timeoutMs: number;
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  /** A refusal by the agent is our bug or setup: logged here with the agent's own code. */
  log?: (line: ErrorLine) => void;
}): TurnAgentPort {
  const doFetch = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const endpoint = `${opts.url.replace(/\/$/, '')}/invocations`;

  return {
    async ask({ home, question, correlationId }): Promise<Result<TurnReply, ErrorEnvelope>> {
      const timeout = AbortSignal.timeout(opts.timeoutMs);
      let response: Response;
      let text: string;
      try {
        response = await Promise.race([
          doFetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.invokeToken}`, 'x-correlation-id': correlationId },
            body: JSON.stringify({ prompt: question, home, correlationId }),
            signal: timeout,
          }),
          new Promise<never>((_resolve, reject) => {
            timeout.addEventListener('abort', () => {
              reject(timeout.reason as Error);
            });
          }),
        ]);
        text = await response.text();
      } catch {
        return timeout.aborted
          ? err(toolError('agent_timeout', `The assistant did not answer within ${String(opts.timeoutMs)} ms.`))
          : err(toolError('agent_unavailable', 'The assistant could not be reached.'));
      }
      const body = parse(text);
      if (response.ok) {
        const reply = TurnReplySchema.safeParse(body);
        if (reply.success) return ok(reply.data);
        // The agent answers its expected failures as a 200 TurnFailure, as the AgentCore adapter reads them (#270).
        const failure = TurnFailureSchema.safeParse(body);
        if (failure.success) return err(fromAgentFailure(failure.data, opts.log));
        return err(toolError('output_schema_violation', 'The assistant sent a reply in an unexpected format.'));
      }
      const problem = ProblemDetailsSchema.safeParse(body);
      if (!problem.success) return err(toolError('agent_unavailable', `The assistant failed (HTTP ${String(response.status)}).`));
      const { code, retryAfterMs } = problem.data;
      return err(fromAgentFailure({ code, retryAfterMs, correlationId }, opts.log));
    },
  };
}

/**
 * An agent failure as the browser may see it (both adapters, HTTP and AgentCore). The agent refused
 * sim-api itself (token, invocation shape, route): a bug or a broken setup, never the visitor's fault, so
 * it must not ask for the demo code again (review of #139): internal, logged with the agent's code. The
 * code passes on otherwise; the text never does (it could carry internals): a fixed message per category.
 */
export function fromAgentFailure(failure: { code: ErrorCode; retryAfterMs?: number | undefined; correlationId: string }, log?: (line: ErrorLine) => void): ErrorEnvelope {
  const { code, retryAfterMs, correlationId } = failure;
  const category = categoryOf(code);
  if (!PASSED_ON.has(category)) {
    log?.({ ts: new Date().toISOString(), level: 'error', component: 'sim-api', message: code, correlationId, code, category, errorName: 'AgentRefused' });
    return toolError('unexpected_error', SAFE_MESSAGE.internal);
  }
  return toolError(code, SAFE_MESSAGE[category], retryAfterMs !== undefined && isRetryableCategory(category) ? { retryAfterMs } : {});
}

/** Agent failures the browser may see as they are: transient ones, and our own internal ones. */
const PASSED_ON: ReadonlySet<ErrorCategory> = new Set(['dependency_unavailable', 'rate_limited', 'internal']);

/** What the browser reads for an agent failure, by category (review of #110). */
const SAFE_MESSAGE: Readonly<Record<ErrorCategory, string>> = {
  validation: 'The question could not be handled. Try asking it another way.',
  guard_rejection: 'That would break a safety rule of the home.',
  not_found: 'Something the assistant needed was not found.',
  unauthorized: 'The demo session is not valid. Enter the demo code again.',
  forbidden: 'That is not allowed in the demo.',
  conflict: 'That was already done.',
  dependency_unavailable: 'The assistant is not available right now. Try again in a moment.',
  rate_limited: 'Too many questions at once. Wait a moment, then ask again.',
  internal: 'Something went wrong on our side.',
};

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
