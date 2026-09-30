import { toolError, type ErrorEnvelope } from '@cold-reserve/contracts';
import { ConcurrentInvocationError, ContextWindowOverflowError, MaxTokensError, ModelError } from '@strands-agents/sdk';

export type Failure = { readonly kind: 'value'; readonly error: ErrorEnvelope; readonly httpStatus?: number } | { readonly kind: 'bug'; readonly error: unknown };

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

const httpStatusOf = (e: unknown): number | undefined => {
  const code = (e as { code?: unknown }).code;
  return typeof code === 'number' && code >= 400 && code <= 599 ? code : undefined;
};

const isNetworkFailure = (e: unknown): boolean => {
  const cause = (e as { cause?: { code?: unknown } }).cause;
  return e instanceof TypeError && typeof cause?.code === 'string' && NETWORK_CODES.has(cause.code);
};

/** A programming error (not a network failure dressed as a TypeError by fetch). */
const isBug = (e: unknown): boolean =>
  (e instanceof TypeError && !isNetworkFailure(e)) || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError;

const OUTAGE = "The assistant can't reach its model or the home right now. Try again in a moment.";
const BROKEN = 'The assistant could not answer this one. Try asking in a different way.';

/**
 * What a failed turn means for the caller (docs/error-handling.md §4): only outages are retryable,
 * because a blind retry pays for the model again. Bugs are rethrown, never hidden as a failed turn.
 * Messages never carry the original error text (it may hold tokens or paths).
 */
export function classifyFailure(e: unknown): Failure {
  // Strands wraps whatever the model throws in a ModelError: a bug stays a bug.
  if (e instanceof ModelError && isBug(e.cause)) return { kind: 'bug', error: e.cause };
  if (e instanceof MaxTokensError || e instanceof ContextWindowOverflowError || e instanceof ConcurrentInvocationError) {
    return { kind: 'value', error: toolError('unexpected_error', BROKEN) };
  }
  if (e instanceof ModelError || isNetworkFailure(e)) return { kind: 'value', error: toolError('agent_unavailable', OUTAGE) };
  const status = httpStatusOf(e);
  if (status === 401 || status === 403) {
    return { kind: 'value', error: toolError('invalid_config', 'The assistant is not allowed to read the home. It needs to be set up again.'), httpStatus: status };
  }
  if (status !== undefined && (status === 429 || status >= 500)) return { kind: 'value', error: toolError('agent_unavailable', OUTAGE), httpStatus: status };
  if (isBug(e)) return { kind: 'bug', error: e };
  return { kind: 'value', error: toolError('unexpected_error', BROKEN), ...(status === undefined ? {} : { httpStatus: status }) };
}
