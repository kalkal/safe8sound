import { ErrorEnvelopeSchema, PROBLEM_JSON_CONTENT_TYPE, toProblemDetails, toolError } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { createRemoteAgent } from '../src/agent/remote-agent.js';

const BASE = 'http://sim-api.test';
const reply = {
  text: 'Your battery is at 64 percent.',
  status: { batterySocPct: 64, origin: { energy: 'live', rooms: 'live', weather: 'simulated' }, ts: '2026-07-15T21:10:00+02:00' },
};

type FakeFetch = (url: string, init: RequestInit) => Promise<Response>;

function agent(fetch: FakeFetch, timeoutMs = 1_000) {
  return createRemoteAgent({ baseUrl: BASE, timeoutMs, fetch });
}

const json = (body: unknown, status = 200, type = 'application/json') =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': type } }));

describe('RemoteAgent (sim-api over HTTP)', () => {
  it('posts the question with the correlation id and returns the validated reply', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await agent((url, init) => {
      calls.push({ url, init });
      return json(reply);
    }).ask("What's my battery level?", { correlationId: 'turn-1' });
    expect(result).toEqual({ ok: true, value: reply });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/v1/turns`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(new Headers(calls[0]?.init.headers).get('x-correlation-id')).toBe('turn-1');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ question: "What's my battery level?" });
  });

  it('gives up after the configured timeout with agent_timeout', async () => {
    const hang: FakeFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    const result = await agent(hang, 10).ask('q', { correlationId: 'c' });
    expect(result).toMatchObject({ ok: false, error: { code: 'agent_timeout', retryable: true } });
  });

  it('maps a network failure to agent_unavailable', async () => {
    const result = await agent(() => Promise.reject(new TypeError('fetch failed'))).ask('q', { correlationId: 'c' });
    expect(result).toMatchObject({ ok: false, error: { code: 'agent_unavailable', category: 'dependency_unavailable' } });
  });

  it('maps a 5xx without a valid problem body to agent_unavailable', async () => {
    const result = await agent(() => Promise.resolve(new Response('<html>Bad gateway</html>', { status: 502 }))).ask('q', { correlationId: 'c' });
    expect(result).toMatchObject({ ok: false, error: { code: 'agent_unavailable', retryable: true } });
  });

  it('keeps the code and retryAfterMs of an RFC 9457 problem', async () => {
    const problem = toProblemDetails(toolError('demo_quota_exceeded', 'The demo quota is used up.', { retryAfterMs: 60_000 }), { instance: 'c' });
    const result = await agent(() => json(problem, 429, PROBLEM_JSON_CONTENT_TYPE)).ask('q', { correlationId: 'c' });
    expect(result).toEqual({
      ok: false,
      error: toolError('demo_quota_exceeded', 'The demo quota is used up.', { retryAfterMs: 60_000 }),
    });
  });

  it('drops retryAfterMs from a problem whose code is not retryable, so the envelope stays valid', async () => {
    const problem = { ...toProblemDetails(toolError('demo_disabled', 'The demo is off.'), { instance: 'c' }), retryAfterMs: 1000 };
    const result = await agent(() => json(problem, 403, PROBLEM_JSON_CONTENT_TYPE)).ask('q', { correlationId: 'c' });
    expect(result).toEqual({ ok: false, error: toolError('demo_disabled', 'The demo is off.') });
    if (!result.ok) expect(ErrorEnvelopeSchema.safeParse(result.error).success).toBe(true);
  });

  it('maps a reply that is not JSON to output_schema_violation', async () => {
    const result = await agent(() => Promise.resolve(new Response('not json', { status: 200 }))).ask('q', { correlationId: 'c' });
    expect(result).toMatchObject({ ok: false, error: { code: 'output_schema_violation', category: 'internal' } });
  });

  it('maps a reply that breaks the wire schema to output_schema_violation', async () => {
    const result = await agent(() => json({ ...reply, status: { ...reply.status, batterySocPct: 101 } })).ask('q', { correlationId: 'c' });
    expect(result).toMatchObject({ ok: false, error: { code: 'output_schema_violation' } });
  });

  it('propagates a cancellation by the caller instead of reporting a failure', async () => {
    const controller = new AbortController();
    const hang: FakeFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    const pending = agent(hang).ask('q', { correlationId: 'c', signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
