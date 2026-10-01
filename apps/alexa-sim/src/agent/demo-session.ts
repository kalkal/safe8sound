import { CORRELATION_ID_HEADER, ProblemDetailsSchema, SessionReplySchema, categoryOf, err, ok, toolError, type ErrorCode, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { log as defaultLog, type Log } from '../log.js';

/**
 * The demo session of remote mode (#101): the code is exchanged for a 1-hour token, kept in memory only
 * (never in localStorage or sessionStorage), and forgotten when sim-api refuses it.
 */
export interface DemoSession {
  token(): string | undefined;
  /** Whether the last token was refused because it expired (the UI says so). */
  expired(): boolean;
  /** Whether the last token was refused at all, expired or not: the gate says why it is back. */
  refused(): boolean;
  /** Exchanges the code; the code itself is not kept anywhere. */
  start(code: string): Promise<Result<undefined, ErrorEnvelope>>;
  invalidate(reason: ErrorCode): void;
  /** For React (useSyncExternalStore): called whenever the token changes. */
  subscribe(listener: () => void): () => void;
}

export function createDemoSession(opts: {
  baseUrl: string;
  timeoutMs: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** A failed exchange leaves one line (review of #140): the code, the step and the error name, never the demo code. */
  log?: Log;
}): DemoSession {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const log = opts.log ?? defaultLog;
  const url = `${opts.baseUrl.replace(/\/$/, '')}/v1/session`;
  let token: string | undefined;
  let expired = false;
  let refused = false;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };

  return {
    token: () => token,
    expired: () => expired,
    refused: () => refused,
    async start(code) {
      const correlationId = crypto.randomUUID();
      const failed = (error: ErrorEnvelope, cause?: unknown) => {
        log({ level: categoryOf(error.code) === 'internal' ? 'error' : 'warn', code: error.code, correlationId, ...(cause === undefined ? {} : { error: cause }), details: { step: 'demo_session' } });
        return err(error);
      };
      let response: Response;
      let body: unknown;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [CORRELATION_ID_HEADER]: correlationId },
          body: JSON.stringify({ code }),
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
        body = await response.json().catch(() => undefined);
      } catch (cause) {
        return failed(toolError('agent_unavailable', 'The demo could not be reached.'), cause);
      }
      if (!response.ok) {
        const problem = ProblemDetailsSchema.safeParse(body);
        return failed(problem.success ? toolError(problem.data.code, problem.data.detail) : toolError('agent_unavailable', 'The demo could not be reached.'));
      }
      const reply = SessionReplySchema.safeParse(body);
      if (!reply.success) return failed(toolError('output_schema_violation', 'The demo sent an unexpected reply.'));
      token = reply.data.token;
      expired = false;
      refused = false;
      changed();
      return ok(undefined);
    },
    invalidate(reason) {
      token = undefined;
      expired = reason === 'signature_expired';
      refused = true;
      changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
