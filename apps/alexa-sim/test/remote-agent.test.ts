import { ErrorEnvelopeSchema, PROBLEM_JSON_CONTENT_TYPE, toProblemDetails, toolError } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { hotDayPlan } from '@cold-reserve/ui-cards';
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

  it('keeps the answer text and the good cards when one card breaks its contract', async () => {
    const body = { text: 'Here is the plan.', cards: [{ tool: 'plan_comfort', result: hotDayPlan() }, { tool: 'plan_comfort', result: { broken: true } }] };
    const result = await agent(() => json(body)).ask('q', { correlationId: 'c' });
    expect(result.ok && result.value.text).toBe('Here is the plan.');
    expect(result.ok && result.value.cards?.map((c) => c.tool)).toEqual(['plan_comfort', 'invalid']);
  });
});

describe('RemoteAgent with a demo session (#101): the token travels, card actions run', () => {
  /** `null` starts with no token. */
  const withSession = (fetch: FakeFetch, token: string | null = 'h.p.s') => {
    let current: string | undefined = token ?? undefined;
    const invalidated: string[] = [];
    const session = {
      token: () => current,
      invalidate: (code: string) => {
        invalidated.push(code);
        current = undefined;
      },
    };
    return { agent: createRemoteAgent({ baseUrl: BASE, timeoutMs: 1_000, fetch, session }), invalidated };
  };

  it('sends the demo token as a Bearer header', async () => {
    let auth: string | null = null;
    await withSession((_url, init) => {
      auth = new Headers(init.headers).get('authorization');
      return json(reply);
    }).agent.ask('q', { correlationId: 'c' });
    expect(auth).toBe('Bearer h.p.s');
  });

  it('asks for the code instead of calling sim-api when there is no token', async () => {
    let called = false;
    const result = await withSession(() => {
      called = true;
      return json(reply);
    }, null).agent.ask('q', { correlationId: 'c' });
    expect(result).toMatchObject({ ok: false, error: { code: 'missing_token' } });
    expect(called).toBe(false);
  });

  it('forgets a token sim-api refuses (401), keeping the reason for the UI', async () => {
    const problem = toProblemDetails(toolError('signature_expired', 'Expired.'), { instance: 'urn:uuid:x' });
    const { agent: a, invalidated } = withSession(() => json(problem, 401, PROBLEM_JSON_CONTENT_TYPE));
    expect(await a.ask('q', { correlationId: 'c' })).toMatchObject({ ok: false, error: { code: 'signature_expired' } });
    expect(invalidated).toEqual(['signature_expired']);
  });

  it('runs a card action through /v1/tools/call and returns the CallToolResult', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const { agent: a } = withSession((url, init) => {
      calls.push({ url, init });
      return json({ content: [{ type: 'text', text: 'Applied.' }], structuredContent: { alreadyApplied: false } });
    });
    expect(a.canCallTools).toBe(true);
    const result = await a.callTool('apply_plan', { planId: 'plan-0001' }, { correlationId: 'c' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'Applied.' }], structuredContent: { alreadyApplied: false } });
    expect(calls[0]?.url).toBe(`${BASE}/v1/tools/call`);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ name: 'apply_plan', arguments: { planId: 'plan-0001' } });
  });

  it('turns a failed card action into a tool error result, never a throw', async () => {
    const problem = toProblemDetails(toolError('demo_quota_exceeded', 'Limit reached.', { retryAfterMs: 1000 }), { instance: 'urn:uuid:x' });
    const result = await withSession(() => json(problem, 429, PROBLEM_JSON_CONTENT_TYPE)).agent.callTool('apply_plan', { planId: 'plan-0001' }, { correlationId: 'c' });
    expect(result.isError).toBe(true);
    expect(ErrorEnvelopeSchema.parse(result.structuredContent).code).toBe('demo_quota_exceeded');
  });
});
