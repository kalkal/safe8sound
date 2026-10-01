import { randomUUID } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { logLine, type AgentLogEntry } from './log.js';
import { PROBLEM_JSON_CONTENT_TYPE, toProblemDetails, toolError, type ErrorEnvelope, type HttpErrorStatus } from '@cold-reserve/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The local agent entry on Node's http server (review of #121): the body is capped while it is read,
 * and a throw becomes an RFC 9457 500 with the correlation id and one log line (error name only).
 */
export function nodeListener(handle: (req: Request) => Promise<Response>, opts: { maxBodyBytes: number; log: (entry: AgentLogEntry) => void }): RequestListener {
  return (req, res) => {
    const presented = req.headers['x-correlation-id'];
    const correlationId = typeof presented === 'string' && UUID.test(presented) ? presented : randomUUID();
    const problem = (error: ErrorEnvelope, status?: HttpErrorStatus) => {
      const body = toProblemDetails(error, { instance: `urn:uuid:${correlationId}`, ...(status === undefined ? {} : { status }) });
      if (!res.headersSent) res.writeHead(body.status, { 'content-type': PROBLEM_JSON_CONTENT_TYPE, 'x-correlation-id': correlationId });
      res.end(JSON.stringify(body));
    };

    void (async () => {
      const body = await readCapped(req, opts.maxBodyBytes);
      if (body === undefined) {
        problem(toolError('payload_too_large', 'The invocation is too large.'), 413);
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
      const method = req.method ?? 'GET';
      const response = await handle(new Request(new URL(req.url ?? '/', 'http://127.0.0.1'), { method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : { body }) }));
      await writeResponse(res, response);
    })().catch((error: unknown) => {
      const failure = toolError('unexpected_error', 'Something went wrong on our side.');
      opts.log(logLine(failure, error instanceof Error ? error.name : typeof error, { correlationId }));
      problem(failure);
    });
  };
}

/** The whole body, or undefined as soon as it passes `max` bytes (the rest is not buffered). */
async function readCapped(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) {
      req.resume(); // drain without keeping it, so the 413 can be written
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}
