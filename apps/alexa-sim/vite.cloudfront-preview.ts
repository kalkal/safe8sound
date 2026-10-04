import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runInNewContext } from 'node:vm';
import type { Plugin } from 'vite';

// The site E2E (K1, #244): `vite preview` of the AWS build stands in for CloudFront at /api/*. It runs the very
// CloudFront Function the distribution runs (infra/cloudfront/api-viewer-request.js, read as text) and forwards what
// it lets through to a real local sim-api. The preview is plain HTTP while CloudFront serves HTTPS only, so the
// browser's Origin is presented with the https scheme, as it is on AWS.

const FUNCTION_FILE = new URL('../../infra/cloudfront/api-viewer-request.js', import.meta.url);

interface CfHeaders { [name: string]: { value: string } | undefined }
interface CfResult { uri?: string; headers?: CfHeaders; statusCode?: number; body?: { data: string } }

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/**
 * The CloudFront stand-in, only when SITE_E2E_SIM_API names the local sim-api. Like the distribution, it adds the
 * origin secret (x-origin-verify) to every request it forwards (#243).
 */
export function cloudFrontStandIn(simApiUrl: string | undefined, originSecret: string | undefined): Plugin | undefined {
  if (simApiUrl === undefined) return undefined;
  const code = readFileSync(FUNCTION_FILE, 'utf8');
  return {
    name: 'cloudfront-stand-in',
    configurePreviewServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = req.url ?? '/';
        if (!url.startsWith('/api')) {
          next();
          return;
        }
        void (async () => {
          const headers: CfHeaders = {};
          for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers[name] = { value };
          const origin = headers['origin'];
          if (origin !== undefined) origin.value = origin.value.replace(/^http:/, 'https:');
          const event = { viewer: { ip: req.socket.remoteAddress ?? '127.0.0.1' }, request: { uri: url, headers } };
          const out = runInNewContext(`${code}\nhandler(event);`, { event }) as CfResult;
          if (out.statusCode !== undefined) {
            res.statusCode = out.statusCode;
            res.setHeader('content-type', 'application/problem+json');
            res.end(out.body?.data ?? '');
            return;
          }
          const forward: Record<string, string> = originSecret === undefined ? {} : { 'x-origin-verify': originSecret };
          for (const [name, value] of Object.entries(out.headers ?? {})) if (value !== undefined && name !== 'host' && name !== 'content-length' && name !== 'x-origin-verify') forward[name] = value.value;
          const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
          const answer = await fetch(new URL(out.uri ?? '/', simApiUrl), { method: req.method ?? 'GET', headers: forward, ...(body === undefined ? {} : { body: new Uint8Array(body) }) });
          res.statusCode = answer.status;
          answer.headers.forEach((value, name) => {
            if (name !== 'content-encoding' && name !== 'content-length' && name !== 'transfer-encoding') res.setHeader(name, value);
          });
          res.end(Buffer.from(await answer.arrayBuffer()));
        })().catch((e: unknown) => {
          res.statusCode = 502;
          res.end(e instanceof Error ? e.name : 'stand-in failure');
        });
      });
    },
  };
}
