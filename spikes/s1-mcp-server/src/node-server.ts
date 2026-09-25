import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

const MAX_BODY_BYTES = 1024 * 1024;

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Buffer | 'too_large'> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return 'too_large';
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Local adapter: node:http <-> Web Request/Response. On Lambda the same handler sits behind the Function URL event. */
export function startNodeServer(
  handle: (req: Request) => Promise<Response>,
  options: { host: string; port: number; path?: string },
): Promise<RunningServer> {
  const path = options.path ?? '/mcp';
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${options.host}`);
      if (url.pathname !== path) {
        res.writeHead(404, { 'content-type': 'application/problem+json' });
        res.end(JSON.stringify({ type: 'urn:cold-reserve:error:not_found', title: 'Not found', status: 404, code: 'not_found' }));
        return;
      }
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      if (body === 'too_large') {
        res.writeHead(413, { 'content-type': 'application/problem+json' });
        res.end(JSON.stringify({ type: 'urn:cold-reserve:error:payload_too_large', title: 'Payload too large', status: 413, code: 'payload_too_large' }));
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(', '));
      }
      const response = await handle(
        new Request(url, { method: req.method ?? 'GET', headers, ...(body !== undefined && { body: new Uint8Array(body) }) }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      // Last-resort boundary: report and answer 500 without internals.
      console.error(JSON.stringify({ level: 'error', component: 'mcp-server', code: 'unexpected_error', message: String(error) }));
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/problem+json' });
      res.end(JSON.stringify({ type: 'urn:cold-reserve:error:unexpected_error', title: 'Internal error', status: 500, code: 'unexpected_error' }));
    });
  });
  server.keepAliveTimeout = 5_000;
  server.requestTimeout = 10_000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://${options.host}:${port}${path}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.closeAllConnections();
            server.close((e) => (e ? fail(e) : done()));
          }),
      });
    });
  });
}
