import { ProblemDetailsSchema, TurnReplySchema, categoryOf, err, isRetryableCategory, ok, toolError, type ErrorCategory, type ErrorEnvelope, type Result, type TurnReply } from '@cold-reserve/contracts';
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
        return reply.success ? ok(reply.data) : err(toolError('output_schema_violation', 'The assistant sent a reply in an unexpected format.'));
      }
      const problem = ProblemDetailsSchema.safeParse(body);
      if (!problem.success) return err(toolError('agent_unavailable', `The assistant failed (HTTP ${String(response.status)}).`));
      const { code, retryAfterMs } = problem.data;
      const category = categoryOf(code);
      // The agent refused sim-api itself (token, invocation shape, route): a bug or a broken setup, never
      // the visitor's fault. It must not ask for the demo code again (review of #139): internal, logged.
      if (!PASSED_ON.has(category)) {
        opts.log?.({ ts: new Date().toISOString(), level: 'error', component: 'sim-api', code, category, correlationId, errorName: 'AgentRefused' });
        return err(toolError('unexpected_error', SAFE_MESSAGE.internal));
      }
      // The code passes on; the text never does (it could carry internals): a fixed message per category.
      return err(toolError(code, SAFE_MESSAGE[category], retryAfterMs !== undefined && isRetryableCategory(categoryOf(code)) ? { retryAfterMs } : {}));
    },
  };
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
