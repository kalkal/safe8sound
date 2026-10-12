import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROBLEM_JSON_CONTENT_TYPE, toProblemDetails, toolError, type ErrorEnvelope, type HttpErrorStatus } from '@cold-reserve/contracts';
import { causeFields, type Logger } from '@cold-reserve/core';
import type { McpHandler } from './handler.js';
import { stdoutLogger } from './stdout-logger.js';

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
  /** Where the last-resort line goes (#143); one JSON line on stdout by default. */
  readonly logger?: Logger;
}

function sendProblem(res: ServerResponse, error: ErrorEnvelope, status?: HttpErrorStatus, headers: Record<string, string> = {}, correlationId: string = randomUUID()) {
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
/**
 * The request URL on the local entry: this server's own host and port, plus the path and query of the request.
 * An absolute request target (`GET http://evil.example/... HTTP/1.1`) or a Host header never names another host.
 */
function localUrl(target: string | undefined, host: string, server: { address(): unknown }): URL {
  const { port } = server.address() as AddressInfo;
  const parsed = new URL(target ?? '/', 'http://placeholder');
  // Set the parts on a fixed base: a path that normalises to "//other.host/..." is then a path, never a host.
  const url = new URL(`http://${host}:${String(port)}`);
  url.pathname = parsed.pathname;
  url.search = parsed.search;
  return url;
}

export function startNodeServer(handle: McpHandler, options: NodeServerOptions): Promise<RunningServer> {
  const logger = options.logger ?? stdoutLogger();
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
      const response = await handle(new Request(localUrl(req.url, options.host, server), { method, headers, ...(body === undefined ? {} : { body }) }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      // Last-resort boundary: log once, with the answer's correlation id and the error class (never its text),
      // and answer a Problem Details 500 without internals.
      const correlationId = randomUUID();
      logger.log({
        ts: new Date().toISOString(),
        level: 'error',
        component: 'mcp-server',
        message: 'unhandled error in the local HTTP adapter',
        correlationId,
        code: 'unexpected_error',
        category: 'internal',
        ...causeFields(error, { withStack: false }),
      });
      sendProblem(res, toolError('unexpected_error', 'The server hit an unexpected error.'), undefined, {}, correlationId);
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
