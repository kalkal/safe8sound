import { PROBLEM_JSON_CONTENT_TYPE, toProblemDetails, toolError } from '@cold-reserve/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createDemoSession } from '../src/agent/demo-session.js';
import type { LogEvent } from '../src/log.js';

const BASE = 'http://sim-api.test';
const CODE = 'judges-demo-code-2026';
const problem = (code: Parameters<typeof toolError>[0], status: number) =>
  Promise.resolve(new Response(JSON.stringify(toProblemDetails(toolError(code, 'No.'), { instance: 'urn:uuid:x' })), { status, headers: { 'content-type': PROBLEM_JSON_CONTENT_TYPE } }));

function session(respond: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const logs: LogEvent[] = [];
  const s = createDemoSession({
    baseUrl: BASE,
    timeoutMs: 1000,
    log: (event) => logs.push(event),
    fetch: (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  });
  return { s, calls, logs };
}

describe('demo session: the code is exchanged for a token kept in memory only (#101)', () => {
  it('posts the code, keeps the token, and never keeps the code', async () => {
    const { s, calls } = session(() => Promise.resolve(Response.json({ token: 'h.p.s', expiresAt: '2026-10-01T13:00:00.000Z' })));
    expect(s.token()).toBeUndefined();
    expect(await s.start(CODE)).toEqual({ ok: true, value: undefined });
    expect(s.token()).toBe('h.p.s');
    expect(calls[0]?.url).toBe(`${BASE}/v1/session`);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ code: CODE });
    expect(JSON.stringify(s)).not.toContain(CODE);
  });

  it('answers invalid_demo_code for a wrong code and keeps no token', async () => {
    const { s } = session(() => problem('invalid_demo_code', 401));
    expect(await s.start(CODE)).toMatchObject({ ok: false, error: { code: 'invalid_demo_code' } });
    expect(s.token()).toBeUndefined();
  });

  it('passes the attempt cap on as demo_quota_exceeded', async () => {
    const { s } = session(() => problem('demo_quota_exceeded', 429));
    expect(await s.start(CODE)).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded' } });
  });

  it('answers agent_unavailable when sim-api cannot be reached', async () => {
    const { s } = session(() => Promise.reject(new TypeError('fetch failed')));
    expect(await s.start(CODE)).toMatchObject({ ok: false, error: { code: 'agent_unavailable' } });
  });

  it('forgets the token when sim-api refuses it, says whether it expired, and notifies the UI', async () => {
    const { s } = session(() => Promise.resolve(Response.json({ token: 'h.p.s', expiresAt: '2026-10-01T13:00:00.000Z' })));
    const listener = vi.fn();
    s.subscribe(listener);
    await s.start(CODE);
    s.invalidate('signature_expired');
    expect(s.token()).toBeUndefined();
    expect(s.expired()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    await s.start(CODE);
    expect(s.expired()).toBe(false);
  });
});

describe('demo session: a failed exchange leaves a trace, never the code (review of #140)', () => {
  it('sends a correlation id with the exchange', async () => {
    const { s, calls } = session(() => Promise.resolve(Response.json({ token: 'h.p.s', expiresAt: '2026-10-01T13:00:00.000Z' })));
    await s.start(CODE);
    expect(new Headers(calls[0]?.init.headers).get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs a refused code with its correlation id and the step, without the code', async () => {
    const { s, calls, logs } = session(() => problem('invalid_demo_code', 401));
    await s.start(CODE);
    const sent = new Headers(calls[0]?.init.headers).get('x-correlation-id');
    expect(logs).toMatchObject([{ level: 'warn', code: 'invalid_demo_code', correlationId: sent, details: { step: 'demo_session' } }]);
    expect(JSON.stringify(logs)).not.toContain(CODE);
  });

  it('logs an unreachable sim-api with the error name', async () => {
    const { s, logs } = session(() => Promise.reject(new TypeError('fetch failed')));
    await s.start(CODE);
    expect(logs).toMatchObject([{ level: 'warn', code: 'agent_unavailable', details: { step: 'demo_session' } }]);
    expect(logs[0]?.error).toBeInstanceOf(TypeError);
  });

  it('remembers that the last token was refused, expired or not, so the gate can say why it is back', async () => {
    const { s } = session(() => Promise.resolve(Response.json({ token: 'h.p.s', expiresAt: '2026-10-01T13:00:00.000Z' })));
    expect(s.refused()).toBe(false);
    await s.start(CODE);
    s.invalidate('invalid_signature');
    expect([s.refused(), s.expired()]).toEqual([true, false]);
    await s.start(CODE);
    expect(s.refused()).toBe(false);
  });
});
