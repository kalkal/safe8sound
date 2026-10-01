import './no-network.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProblemDetailsSchema } from '@cold-reserve/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeListener } from '../src/node-listener.js';

// The local agent entry's Node adapter (review of #121): the body is capped while it is read, and a
// throw becomes an RFC 9457 500 with the correlation id, plus one log line without the message.

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

async function serve(handle: (req: Request) => Promise<Response>, maxBodyBytes = 1024) {
  const logs: object[] = [];
  server = createServer(nodeListener(handle, { maxBodyBytes, log: (line) => logs.push(line) }));
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}/invocations`, logs };
}

describe('nodeListener (local agent entry)', () => {
  it('passes method, headers and body to the Web handler and writes its response back', async () => {
    const { url } = await serve(async (req) => new Response(JSON.stringify({ got: await req.text(), auth: req.headers.get('authorization') }), { status: 201 }));
    const res = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer x' }, body: 'hello' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ got: 'hello', auth: 'Bearer x' });
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
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(res.headers.get('x-correlation-id')).toBe(ID);
    expect(ProblemDetailsSchema.parse(await res.json())).toMatchObject({ code: 'unexpected_error', instance: `urn:uuid:${ID}` });
    expect(logs).toMatchObject([{ level: 'error', component: 'agent', code: 'unexpected_error', category: 'internal', correlationId: ID, errorName: 'TypeError' }]);
    expect(JSON.stringify(logs)).not.toContain('secret detail');
  });
});
