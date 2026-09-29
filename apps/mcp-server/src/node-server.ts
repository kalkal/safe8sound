import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROBLEM_JSON_CONTENT_TYPE, toProblemDetails, toolError, type ErrorEnvelope, type HttpErrorStatus } from '@cold-reserve/contracts';
import type { McpHandler } from './handler.js';

export interface RunningServer {
  readonly url: string;
  close(): Promise<void>;
}

export interface NodeServerOptions {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  /** Reading stops as soon as the body goes past this size (413). */
  readonly maxBodyBytes: number;
}

function sendProblem(res: ServerResponse, error: ErrorEnvelope, status?: HttpErrorStatus, headers: Record<string, string> = {}) {
  const correlationId = randomUUID();
  const body = toProblemDetails(error, { instance: `urn:uuid:${correlationId}`, ...(status === undefined ? {} : { status }) });
  if (!res.headersSent) res.writeHead(body.status, { 'content-type': PROBLEM_JSON_CONTENT_TYPE, 'x-correlation-id': correlationId, ...headers });
  res.end(JSON.stringify(body));
}

/** Resolves with the body, or with 'too_large' as soon as it goes past the limit (the rest is not read). */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | 'too_large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.off('data', onData);
        req.pause();
        resolve('too_large');
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.once('error', reject);
  });
}

/**
 * Local adapter: node:http <-> Web Request/Response around the same handler as the Lambda entry.
 * Path, method, Origin and token checks live in the handler, so both entries behave alike.
 */
export function startNodeServer(handle: McpHandler, options: NodeServerOptions): Promise<RunningServer> {
  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req, options.maxBodyBytes);
      if (body === 'too_large') {
        sendProblem(res, toolError('payload_too_large', `The request body is over ${options.maxBodyBytes} bytes.`), 413, { connection: 'close' });
        res.once('finish', () => req.destroy());
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(', '));
      }
      const response = await handle(
        new Request(new URL(req.url ?? '/', `http://${options.host}`), { method, headers, ...(body === undefined ? {} : { body }) }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      // Last-resort boundary: log once and answer a Problem Details 500 without internals.
      console.error(JSON.stringify({ level: 'error', component: 'mcp-server', code: 'unexpected_error', message: error instanceof Error ? error.name : 'unknown' }));
      sendProblem(res, toolError('unexpected_error', 'The server hit an unexpected error.'));
    });
  });
  server.keepAliveTimeout = 5_000;
  server.requestTimeout = 10_000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://${options.host}:${String(port)}${options.path}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.closeAllConnections();
            server.close((e) => {
              if (e) fail(e);
              else done();
            });
          }),
      });
    });
  });
}
