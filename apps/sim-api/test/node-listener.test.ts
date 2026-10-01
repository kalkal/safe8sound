import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProblemDetailsSchema } from '@cold-reserve/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeListener } from '../src/node-listener.js';

// The local sim-api entry's Node adapter (reviews of #110 and #121): the client IP is the socket's,
// never a header the caller can write; the body is capped while it is read; a throw is an RFC 9457 500.

const ID = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';
let server: Server | undefined;

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running) {
    await new Promise<void>((resolve) => {
      running.close(() => {
        resolve();
      });
    });
  }
});

async function serve(handle: (req: Request, meta: { clientIp: string }) => Promise<Response>, maxBodyBytes = 1024) {
  const logs: object[] = [];
  server = createServer(nodeListener(handle, { maxBodyBytes, log: (line) => logs.push(line) }));
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}/v1/session`, logs };
}

describe('nodeListener (local sim-api entry)', () => {
  it('takes the client IP from the socket and ignores X-Forwarded-For', async () => {
    const seen: string[] = [];
    const { url } = await serve((_req, meta) => {
      seen.push(meta.clientIp);
      return Promise.resolve(new Response('{}'));
    });
    await fetch(url, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.99', 'x-real-ip': '203.0.113.98' }, body: '{}' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/127\.0\.0\.1$/);
  });

  it('answers 413 Problem Details as soon as the body passes the cap, without calling the handler', async () => {
    let called = false;
    const { url } = await serve(() => {
      called = true;
      return Promise.resolve(new Response('ok'));
    });
    const res = await fetch(url, { method: 'POST', body: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
    expect(ProblemDetailsSchema.parse(await res.json()).code).toBe('payload_too_large');
    expect(called).toBe(false);
  });

  it('turns a throw into a 500 unexpected_error with the correlation id, and logs the error name only', async () => {
    const { url, logs } = await serve(() => Promise.reject(new TypeError('secret detail')));
    const res = await fetch(url, { method: 'POST', headers: { 'x-correlation-id': ID }, body: '{}' });
    expect(res.status).toBe(500);
    expect(res.headers.get('x-correlation-id')).toBe(ID);
    expect(ProblemDetailsSchema.parse(await res.json())).toMatchObject({ code: 'unexpected_error', instance: `urn:uuid:${ID}` });
    expect(logs).toMatchObject([{ level: 'error', component: 'sim-api', code: 'unexpected_error', category: 'internal', correlationId: ID, errorName: 'TypeError' }]);
    expect(JSON.stringify(logs)).not.toContain('secret detail');
  });
});
