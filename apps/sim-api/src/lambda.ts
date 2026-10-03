import { randomUUID } from 'node:crypto';
import { CORRELATION_ID_HEADER, PROBLEM_JSON_CONTENT_TYPE, correlationIdFrom, toProblemDetails, toolError, type ErrorEnvelope, type LogEntry, type Result } from '@cold-reserve/contracts';
import type { SimApiHandler } from './handler.js';

/** The subset of the Lambda Function URL event (payload 2.0) the adapter reads. */
export interface FunctionUrlEvent {
  readonly rawPath: string;
  readonly rawQueryString: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  readonly isBase64Encoded: boolean;
  readonly requestContext: { readonly domainName: string; readonly http: { readonly method: string; readonly sourceIp: string } };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

/** JSON, Problem Details and text travel as text; anything else (the spoken reply's mp3) as base64 (review of #180). */
const isText = (contentType: string | null) => contentType === null || /^(text\/|application\/(problem\+)?json)/i.test(contentType);

async function toResult(response: Response): Promise<FunctionUrlResult> {
  const headers = Object.fromEntries(response.headers);
  if (isText(response.headers.get('content-type'))) return { statusCode: response.status, headers, body: await response.text(), isBase64Encoded: false };
  return { statusCode: response.status, headers, body: Buffer.from(await response.arrayBuffer()).toString('base64'), isBase64Encoded: true };
}

function toRequest(event: FunctionUrlEvent): Request {
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) if (value !== undefined) headers.set(key, value);
  const method = event.requestContext.http.method;
  const withBody = !(method === 'GET' || method === 'HEAD' || method === 'OPTIONS');
  const body = event.body === undefined || !withBody ? undefined : event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  return new Request(`https://${event.requestContext.domainName}${event.rawPath}${query}`, { method, headers, ...(body === undefined ? {} : { body }) });
}

function problem(error: ErrorEnvelope, correlationId: string): FunctionUrlResult {
  const body = toProblemDetails(error, { instance: `urn:uuid:${correlationId}` });
  return { statusCode: body.status, headers: { 'content-type': PROBLEM_JSON_CONTENT_TYPE, [CORRELATION_ID_HEADER]: correlationId }, body: JSON.stringify(body), isBase64Encoded: false };
}

/**
 * The sim-api Lambda entry (#17, the sim-api stack): the same Web handler as the local entry, behind a
 * Function URL. The client IP for the per-IP caps is the one AWS saw (`requestContext.http.sourceIp`),
 * never X-Forwarded-For or another header the caller writes (review of #110). The handler is built once
 * per container; a failed or rejected build is not kept, and nothing escapes as a raw 502: every failure
 * is RFC 9457 with a log line carrying the correlation id (same last resort as the MCP Lambda, #112).
 */
export function createSimApiLambda(
  load: () => Promise<Result<SimApiHandler, ErrorEnvelope>>,
  deps: { readonly log: (entry: LogEntry) => void },
): (event: FunctionUrlEvent) => Promise<FunctionUrlResult> {
  let ready: Promise<Result<SimApiHandler, ErrorEnvelope>> | undefined;
  const line = (error: ErrorEnvelope, correlationId: string, extra: { errorName?: string; reason?: string } = {}): LogEntry => ({
    ts: new Date().toISOString(),
    level: error.category === 'internal' ? 'error' : 'warn',
    component: 'sim-api',
    message: error.code,
    correlationId,
    code: error.code,
    category: error.category,
    ...(extra.errorName === undefined ? {} : { errorName: extra.errorName }),
    ...(extra.reason === undefined ? {} : { details: { reason: extra.reason } }),
  });
  const unexpected = (e: unknown, correlationId: string) => {
    const error = toolError('unexpected_error', 'Something went wrong on our side.');
    deps.log(line(error, correlationId, { errorName: e instanceof Error ? e.name : typeof e }));
    return problem(error, correlationId);
  };

  return async (event) => {
    const correlationId = correlationIdFrom(event.headers[CORRELATION_ID_HEADER], randomUUID);
    let built: Result<SimApiHandler, ErrorEnvelope>;
    try {
      ready ??= load();
      built = await ready;
    } catch (e) {
      ready = undefined; // a rejected build is not cached: the next request retries
      return unexpected(e, correlationId);
    }
    if (!built.ok) {
      ready = undefined; // a later request retries the configuration
      // Our own reason stays in the log; the caller only learns whether to retry.
      deps.log(line(built.error, correlationId, { reason: built.error.message }));
      const shown = built.error.category === 'dependency_unavailable' ? toolError(built.error.code, 'The demo cannot reach a service it needs. Try again in a moment.', built.error.retryAfterMs === undefined ? {} : { retryAfterMs: built.error.retryAfterMs }) : toolError('invalid_config', 'The demo is not configured correctly.');
      return problem(shown, correlationId);
    }
    try {
      const response = await built.value(toRequest(event), { clientIp: event.requestContext.http.sourceIp });
      return await toResult(response);
    } catch (e) {
      return unexpected(e, correlationId);
    }
  };
}
