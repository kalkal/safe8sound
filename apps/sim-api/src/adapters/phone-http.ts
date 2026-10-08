import { HOME_HEADER, PhoneInboxSchema, ProblemDetailsSchema, categoryOf, err, ok, toolError, type ErrorEnvelope, type PhoneInbox, type Result } from '@cold-reserve/contracts';
import type { PhoneInboxPort } from '../handler.js';

/**
 * A visitor sandbox's family inbox, read from the MCP server (#267, approved in #267): GET /phone/inbox on the MCP
 * server's origin, with sim-api's own sandbox phone token and the sandbox in x-cold-reserve-home. The token stays
 * here, never in the browser. A refusal by the MCP server is our setup (token, scope, home): internal, with a fixed
 * text; a transient failure passes on, so the panel keeps its list and retries at the next poll.
 */
export function httpPhoneInbox(opts: {
  mcpUrl: string;
  token: string;
  timeoutMs: number;
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
}): PhoneInboxPort {
  const doFetch = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const endpoint = new URL('/phone/inbox', opts.mcpUrl).toString();
  const unavailable = () => toolError('store_unavailable', 'The family phone is not available right now. Try again in a moment.');

  return {
    async inbox({ home, correlationId }): Promise<Result<PhoneInbox, ErrorEnvelope>> {
      const timeout = AbortSignal.timeout(opts.timeoutMs);
      let response: Response;
      let text: string;
      try {
        response = await Promise.race([
          doFetch(endpoint, {
            method: 'GET',
            headers: { authorization: `Bearer ${opts.token}`, [HOME_HEADER]: home, 'x-correlation-id': correlationId },
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
        return err(unavailable());
      }
      const body = parse(text);
      if (response.ok) {
        const inbox = PhoneInboxSchema.safeParse(body);
        return inbox.success ? ok(inbox.data) : err(toolError('output_schema_violation', 'The family phone sent an inbox in an unexpected format.'));
      }
      const problem = ProblemDetailsSchema.safeParse(body);
      if (!problem.success) return err(unavailable());
      const category = categoryOf(problem.data.code);
      if (category === 'dependency_unavailable' || category === 'rate_limited') return err(unavailable());
      return err(toolError('unexpected_error', 'Something went wrong on our side.'));
    },
  };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
