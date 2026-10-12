import { LogEntrySchema, ProblemDetailsSchema } from '@cold-reserve/contracts';
import { memoryLogger } from '@cold-reserve/core';
import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startNodeServer, type RunningServer } from '../src/node-server.js';

let server: RunningServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('startNodeServer (local entry adapter)', () => {
  it('answers 413 as Problem Details without reading the body past maxBodyBytes or calling the handler', async () => {
    const handle = vi.fn(() => Promise.resolve(new Response('unused')));
    server = await startNodeServer(handle, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: 100 });
    const res = await fetch(server.url, { method: 'POST', body: 'x'.repeat(10_000) });
    expect(res.status).toBe(413);
    expect(ProblemDetailsSchema.parse(await res.json())).toMatchObject({ code: 'payload_too_large', status: 413 });
    expect(handle).not.toHaveBeenCalled();
  });

  it('passes a body within the limit to the handler', async () => {
    const handle = vi.fn(async (req: Request) => new Response(await req.text()));
    server = await startNodeServer(handle, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: 100 });
    const res = await fetch(server.url, { method: 'POST', body: 'hello' });
    expect(await res.text()).toBe('hello');
  });

  it('turns a handler crash into a valid 500 Problem Details with a correlation id, without internals', async () => {
    const logger = memoryLogger();
    server = await startNodeServer(() => Promise.reject(new Error('boom at /secret/path.ts')), { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: 100, logger });
    const res = await fetch(server.url, { method: 'POST', body: '{}' });
    expect(res.status).toBe(500);
    const body = ProblemDetailsSchema.parse(await res.json());
    expect(body).toMatchObject({ code: 'unexpected_error', status: 500 });
    const correlationId = res.headers.get('x-correlation-id') ?? '';
    expect(body.instance).toBe(`urn:uuid:${correlationId}`);
    expect(JSON.stringify(body)).not.toContain('/secret/path');
    // #143: one shared LogEntry line, with the answer's correlation id and the error class, never its text.
    expect(logger.lines).toHaveLength(1);
    expect(LogEntrySchema.parse(logger.lines[0])).toMatchObject({ level: 'error', component: 'mcp-server', code: 'unexpected_error', category: 'internal', correlationId, errorName: 'Error' });
    expect(JSON.stringify(logger.lines)).not.toContain('/secret/path');
  });

  it('builds the request URL from the path and query only: an absolute request target cannot name another host (#149)', async () => {
    let seen = '';
    server = await startNodeServer((req) => ((seen = req.url), Promise.resolve(new Response('ok'))), { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: 100 });
    const { port } = new URL(server.url);
    await new Promise<void>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: Number(port), method: 'GET', path: 'http://evil.example/mcp?x=1', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      r.on('error', reject);
      r.end();
    });
    expect(seen).toBe(`http://127.0.0.1:${port}/mcp?x=1`);
  });

  it('a path that normalises to //host never names another host either (#149 re-review)', async () => {
    let seen = '';
    server = await startNodeServer((req) => ((seen = req.url), Promise.resolve(new Response('ok'))), { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: 100 });
    const { port } = new URL(server.url);
    for (const path of ['/.//evil.example/mcp', '//evil.example/mcp']) {
      await new Promise<void>((resolve, reject) => {
        const r = request({ host: '127.0.0.1', port: Number(port), method: 'GET', path }, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        r.on('error', reject);
        r.end();
      });
      expect(new URL(seen).host).toBe(`127.0.0.1:${port}`);
    }
  });
});
