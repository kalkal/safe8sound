import { randomUUID } from 'node:crypto';
import { CORRELATION_ID_HEADER, PROBLEM_JSON_CONTENT_TYPE, categoryOf, correlationIdFrom, toProblemDetails, toolError, type ErrorCategory, type ErrorEnvelope, type LogEntry, type Result } from '@cold-reserve/contracts';
import { jsonLineSink, loggerTo } from '@cold-reserve/core';
import type { StoreErrorEvent } from '@cold-reserve/store-dynamodb';
import type { McpHandler } from './handler.js';

/** The subset of the Lambda Function URL event (payload 2.0) the adapter reads. */
export interface FunctionUrlEvent {
  readonly rawPath: string;
  readonly rawQueryString: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  readonly isBase64Encoded: boolean;
  readonly requestContext: { readonly domainName: string; readonly http: { readonly method: string } };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}

/**
 * One line of the error log, in the shape of docs/error-handling.md §6.1 until L1 brings the shared
 * logger. `message` is ours (configuration failures); a caught error only gives its name.
 */
export interface LambdaLogEntry {
  readonly ts: string;
  readonly level: 'warn' | 'error';
  readonly component: 'mcp-server' | 'store-dynamodb';
  readonly code: ErrorEnvelope['code'];
  readonly category: ErrorCategory;
  readonly correlationId?: string;
  readonly errorName?: string;
  readonly message?: string;
  readonly operation?: string;
  readonly httpStatus?: number;
  readonly requestId?: string;
}

const levelOf = (category: ErrorCategory): LambdaLogEntry['level'] => (category === 'internal' ? 'error' : 'warn');
const nameOf = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

/**
 * A Lambda line in the shared LogEntry shape of L1 (#111): the store fields go under `details`, the code is
 * the message when we have none, and a line without a request (process hooks) says `none`.
 */
export function toLogEntry(e: LambdaLogEntry): LogEntry {
  const details = {
    ...(e.operation === undefined ? {} : { operation: e.operation }),
    ...(e.httpStatus === undefined ? {} : { httpStatus: e.httpStatus }),
    ...(e.requestId === undefined ? {} : { requestId: e.requestId }),
  };
  return {
    ts: e.ts,
    level: e.level,
    component: e.component,
    message: e.message ?? e.code,
    correlationId: e.correlationId ?? 'none',
    code: e.code,
    category: e.category,
    ...(e.errorName === undefined ? {} : { errorName: e.errorName }),
    ...(Object.keys(details).length === 0 ? {} : { details }),
  };
}

// The one sink of the Lambda: a JSON line on stdout (reviews of #134 and #139).
const stdoutLogger = loggerTo(
  jsonLineSink((text) => {
    process.stdout.write(text);
  }),
);
const defaultLog = (entry: LambdaLogEntry) => {
  stdoutLogger.log(toLogEntry(entry));
};

function toRequest(event: FunctionUrlEvent): Request {
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) if (value !== undefined) headers.set(key, value);
  const method = event.requestContext.http.method;
  const body = event.body === undefined || method === 'GET' || method === 'HEAD' ? undefined : event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  return new Request(`https://${event.requestContext.domainName}${event.rawPath}${query}`, { method, headers, ...(body === undefined ? {} : { body }) });
}

async function toResult(res: Response): Promise<FunctionUrlResult> {
  return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: await res.text(), isBase64Encoded: false };
}

function problem(error: ErrorEnvelope, correlationId: string): FunctionUrlResult {
  const body = toProblemDetails(error, { instance: `urn:uuid:${correlationId}` });
  return { statusCode: body.status, headers: { 'content-type': PROBLEM_JSON_CONTENT_TYPE, [CORRELATION_ID_HEADER]: correlationId }, body: JSON.stringify(body), isBase64Encoded: false };
}

/** What the caller learns about a startup failure: transient ones keep their code (503, retry); the rest is a generic 500. */
function publicStartupError(error: ErrorEnvelope): ErrorEnvelope {
  return error.category === 'dependency_unavailable'
    ? toolError(error.code, 'A service the server needs is not reachable. Try again in a moment.')
    : toolError('invalid_config', 'The server is not configured correctly.');
}

/**
 * Lambda entry around the same Web-standard handler as the local Node entry. The app is built once per
 * container; a failed or rejected build is not kept, so the next request tries again. Nothing escapes as
 * a raw 502: every failure is an RFC 9457 answer with a log line carrying the correlation id.
 */
export function createLambdaHandler(
  load: () => Promise<Result<McpHandler, ErrorEnvelope>>,
  deps: { readonly log?: (entry: LambdaLogEntry) => void } = {},
): (event: FunctionUrlEvent) => Promise<FunctionUrlResult> {
  const log = deps.log ?? defaultLog;
  let ready: Promise<Result<McpHandler, ErrorEnvelope>> | undefined;

  const unexpected = (e: unknown, correlationId: string) => {
    log({ ts: new Date().toISOString(), level: 'error', component: 'mcp-server', code: 'unexpected_error', category: 'internal', correlationId, errorName: nameOf(e) });
    return problem(toolError('unexpected_error', 'Something went wrong on our side.'), correlationId);
  };

  return async (event) => {
    const correlationId = correlationIdFrom(event.headers[CORRELATION_ID_HEADER], randomUUID);

    let app: Result<McpHandler, ErrorEnvelope>;
    try {
      ready ??= load();
      app = await ready;
    } catch (e) {
      ready = undefined; // a rejected build is not cached: the next request retries
      return unexpected(e, correlationId);
    }
    if (!app.ok) {
      ready = undefined; // a later request retries the configuration
      const error = app.error;
      // The detail stays in the log; the caller only learns whether to retry.
      log({ ts: new Date().toISOString(), level: levelOf(error.category), component: 'mcp-server', code: error.code, category: error.category, correlationId, message: error.message });
      return problem(publicStartupError(error), correlationId);
    }

    try {
      return await toResult(await app.value(toRequest(event)));
    } catch (e) {
      return unexpected(e, correlationId);
    }
  };
}

/** Last-resort process hooks: an unhandled rejection is logged; an uncaught exception is logged and the container exits. */
export function installProcessHooks(
  proc: { on(name: 'unhandledRejection' | 'uncaughtException', fn: (value: unknown) => void): unknown },
  deps: { readonly log?: (entry: LambdaLogEntry) => void; readonly exit: (code: number) => void },
): void {
  const log = deps.log ?? defaultLog;
  const line = (e: unknown): LambdaLogEntry => ({ ts: new Date().toISOString(), level: 'error', component: 'mcp-server', code: 'unexpected_error', category: 'internal', errorName: nameOf(e) });
  proc.on('unhandledRejection', (reason) => {
    log(line(reason));
  });
  proc.on('uncaughtException', (error) => {
    log(line(error));
    deps.exit(1); // the state may be broken: the runtime starts a clean container
  });
}

/** The DynamoDB store's error event as a log line: the SDK error name, HTTP status and request id, never the cause text. */
export function storeErrorLine(event: StoreErrorEvent): LambdaLogEntry {
  const category = categoryOf(event.code);
  const metadata = (event.cause as { $metadata?: { httpStatusCode?: unknown; requestId?: unknown } } | null | undefined)?.$metadata;
  return {
    ts: new Date().toISOString(),
    level: levelOf(category),
    component: 'store-dynamodb',
    code: event.code,
    category,
    operation: event.operation,
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
    errorName: nameOf(event.cause),
    ...(typeof metadata?.httpStatusCode === 'number' ? { httpStatus: metadata.httpStatusCode } : {}),
    ...(typeof metadata?.requestId === 'string' ? { requestId: metadata.requestId } : {}),
  };
}

/** The store's onError hook as lambda-main wires it: every failure becomes one log line, with its correlation id. */
export const storeErrorLogger =
  (log: (entry: LambdaLogEntry) => void) =>
  (event: StoreErrorEvent): void => {
    log(storeErrorLine(event));
  };
