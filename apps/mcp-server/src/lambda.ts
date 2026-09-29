import { randomUUID } from 'node:crypto';
import { PROBLEM_JSON_CONTENT_TYPE, toProblemDetails, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
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

function configFailure(error: ErrorEnvelope): FunctionUrlResult {
  const correlationId = randomUUID();
  // The detail stays in the log; the caller only learns that the server is misconfigured.
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', component: 'mcp-server', code: error.code, category: error.category, message: error.message, correlationId }));
  const body = toProblemDetails(toolError('invalid_config', 'The server is not configured correctly.'), { instance: `urn:uuid:${correlationId}` });
  return { statusCode: body.status, headers: { 'content-type': PROBLEM_JSON_CONTENT_TYPE, 'x-correlation-id': correlationId }, body: JSON.stringify(body), isBase64Encoded: false };
}

/** Lambda entry around the same Web-standard handler as the local Node entry. Built once per container. */
export function createLambdaHandler(load: () => Promise<Result<McpHandler, ErrorEnvelope>>): (event: FunctionUrlEvent) => Promise<FunctionUrlResult> {
  let ready: Promise<Result<McpHandler, ErrorEnvelope>> | undefined;
  return async (event) => {
    ready ??= load();
    const app = await ready;
    if (!app.ok) {
      ready = undefined; // a later request retries the configuration
      return configFailure(app.error);
    }
    return toResult(await app.value(toRequest(event)));
  };
}
