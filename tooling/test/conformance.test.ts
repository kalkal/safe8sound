import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createBearerProxy, listenOn } from '../src/conformance.mjs';

// G5 (#153): the official MCP conformance suite sends no token, and our server requires one. The proxy adds the
// bearer to every request and hands the reply back unchanged.

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

describe('createBearerProxy', () => {
  it('adds the bearer, keeps the method, path, headers and body, and returns the reply as it is', async () => {
    const seen: { method?: string; url?: string; auth?: string; version?: string; body?: string } = {};
    const target = await listen(
      createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          Object.assign(seen, { method: req.method, url: req.url, auth: req.headers.authorization, version: req.headers['mcp-protocol-version'], body });
          res.writeHead(202, { 'content-type': 'application/json', 'x-correlation-id': 'c-1' });
          res.end('{"ok":true}');
        });
      }),
    );
    const proxy = await listen(createBearerProxy({ target, token: 't'.repeat(32) }));
    const res = await fetch(`${proxy}/mcp?x=1`, { method: 'POST', headers: { 'mcp-protocol-version': '2025-11-25', authorization: 'Bearer wrong' }, body: '{"jsonrpc":"2.0"}' });
    expect(seen).toEqual({ method: 'POST', url: '/mcp?x=1', auth: `Bearer ${'t'.repeat(32)}`, version: '2025-11-25', body: '{"jsonrpc":"2.0"}' });
    expect(res.status).toBe(202);
    expect(res.headers.get('x-correlation-id')).toBe('c-1');
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('answers 502 when the server is not there, and says why in one JSON line', async () => {
    const lines: string[] = [];
    const proxy = await listen(createBearerProxy({ target: 'http://127.0.0.1:1', token: 't'.repeat(32), log: (l) => lines.push(l) }));
    expect((await fetch(`${proxy}/mcp`, { method: 'POST', body: '{}' })).status).toBe(502);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ component: 'conformance-proxy', code: 'upstream_unavailable', errorName: 'Error' });
    expect(lines[0]?.endsWith('\n')).toBe(true);
  });

  it('drops the request to the server when the client goes away', async () => {
    let closed = false;
    const target = await listen(
      createServer((req) => {
        req.on('close', () => (closed = true));
      }),
    );
    const proxy = await listen(createBearerProxy({ target, token: 't'.repeat(32), log: () => undefined }));
    const abort = new AbortController();
    const pending = fetch(`${proxy}/mcp`, { method: 'POST', body: '{}', signal: abort.signal }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    abort.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(true);
  });
});

describe('listenOn', () => {
  it('rejects when the port is taken, so the runner can stop the MCP server it started', async () => {
    const taken = await listen(createServer());
    const port = Number(new URL(taken).port);
    const second = createServer();
    servers.push(second);
    await expect(listenOn(second, port)).rejects.toThrow();
  });
});
