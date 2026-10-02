import './no-network.js';
import { TurnFailureSchema, ProblemDetailsSchema, TurnReplySchema, err, ok, toolError, type HomeId } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { createInvocationHandler, type HomeAgent, type InvocationAuth } from '../src/invocations.js';
import type { AgentLogEntry } from '../src/log.js';

const TOKEN = 'i'.repeat(48);
const URL_BASE = 'http://127.0.0.1:3340';
const ID = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';

const REPLY = TurnReplySchema.parse({ text: 'Your battery is at 45%.', status: { batterySocPct: 45, origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated' }, ts: '2026-07-15T12:00:00.000Z' } });

function setup(answer: HomeAgent['ask'] = () => Promise.resolve(ok(REPLY)), auth: InvocationAuth = { kind: 'token', invokeToken: TOKEN }, failuresAs: 'problem' | 'envelope' = 'problem') {
  const homes: HomeId[] = [];
  const logs: AgentLogEntry[] = [];
  const handler = createInvocationHandler({
    log: (entry) => logs.push(entry),
    auth,
    failuresAs,
    maxBodyBytes: 4096,
    agentFor: (home) => {
      homes.push(home);
      return { ask: answer };
    },
  });
  /** `null` sends no token at all. */
  const post = (body: unknown, token: string | null = TOKEN, path = '/invocations', extra: Record<string, string> = {}) =>
    handler(
      new Request(`${URL_BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...extra },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  return { handler, post, homes, logs };
}

async function problem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(ProblemDetailsSchema.parse(await res.json()).code).toBe(code);
}

describe('agent invocation entry (AgentCore runtime shape: POST /invocations, GET /ping)', () => {
  it('answers /ping as healthy without a token', async () => {
    const res = await setup().handler(new Request(`${URL_BASE}/ping`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'Healthy' });
  });

  it('runs the turn for the home of the invocation and answers a TurnReply', async () => {
    const { post, homes } = setup();
    const res = await post({ prompt: "What's my battery level?", home: 'demo#0123456789abcdef', correlationId: '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60' });
    expect(res.status).toBe(200);
    expect(TurnReplySchema.parse(await res.json()).text).toBe('Your battery is at 45%.');
    expect(homes).toEqual(['demo#0123456789abcdef']);
  });

  it('refuses the real home: invocations serve sandbox homes only', async () => {
    const { post, homes } = setup();
    await problem(await post({ prompt: 'Hi', home: 'home' }), 400, 'invalid_input');
    expect(homes).toEqual([]);
  });

  it('answers 401 without the invoke token or with another one', async () => {
    const { post } = setup();
    await problem(await post({ prompt: 'Hi', home: 'demo#0123456789abcdef' }, null), 401, 'missing_token');
    await problem(await post({ prompt: 'Hi', home: 'demo#0123456789abcdef' }, 'x'.repeat(48)), 401, 'wrong_client');
  });

  it('answers 400 to a body that is not an invocation, 404 to another path, 413 to a large body', async () => {
    const { post } = setup();
    await problem(await post({ question: 'Hi' }), 400, 'invalid_input');
    await problem(await post({ prompt: 'Hi', home: 'demo#0123456789abcdef' }, TOKEN, '/other'), 404, 'route_not_found');
    await problem(await post({ prompt: 'x'.repeat(5000), home: 'demo#0123456789abcdef' }), 413, 'payload_too_large');
  });

  it('passes the agent failures on as Problem Details (agent_timeout -> 503)', async () => {
    const { post } = setup(() => Promise.resolve(err(toolError('agent_timeout', 'Too slow.'))));
    await problem(await post({ prompt: 'Hi', home: 'demo#0123456789abcdef' }), 503, 'agent_timeout');
  });
  it('takes the turn id from x-correlation-id when the body has none, and answers with it', async () => {
    const seen: string[] = [];
    const { post } = setup((_question, correlationId) => {
      seen.push(correlationId);
      return Promise.resolve(err(toolError('agent_timeout', 'Too slow.')));
    });
    const res = await post({ prompt: 'Hi', home: 'demo#0123456789abcdef' }, TOKEN, '/invocations', { 'x-correlation-id': ID });
    expect(seen).toEqual([ID]);
    expect(ProblemDetailsSchema.parse(await res.json()).instance).toBe(`urn:uuid:${ID}`);
  });

  it('ignores an x-correlation-id that is not a UUID', async () => {
    const seen: string[] = [];
    const { post } = setup((_question, correlationId) => {
      seen.push(correlationId);
      return Promise.resolve(ok(REPLY));
    });
    await post({ prompt: 'Hi', home: 'demo#0123456789abcdef' }, TOKEN, '/invocations', { 'x-correlation-id': 'not-a-uuid' });
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs every refusal in the shared log shape, with the correlation id and no message', async () => {
    const { post, logs } = setup();
    await post({ prompt: 'Hi', home: 'demo#0123456789abcdef' }, 'x'.repeat(48), '/invocations', { 'x-correlation-id': ID });
    expect(logs).toMatchObject([{ level: 'warn', component: 'agent', code: 'wrong_client', category: 'unauthorized', correlationId: ID, errorName: 'InvocationRefused' }]);
    expect(logs).toHaveLength(1);
    expect(Object.keys(logs[0] ?? {}).sort()).toEqual(['category', 'code', 'component', 'correlationId', 'errorName', 'level', 'message', 'ts']);
    // The message is the code (#143): never the refusal text.
    expect(logs[0]?.message).toBe('wrong_client');
    expect(JSON.stringify(logs)).not.toContain('may not invoke');
  });
});

describe('AgentCore runtime entry: the platform authenticates the caller (G1a, IAM/SigV4 decided in #17)', () => {
  it('serves an invocation without any bearer token', async () => {
    const { post, homes } = setup(undefined, { kind: 'platform' });
    const res = await post({ prompt: 'Hi', home: 'demo#0123456789abcdef' }, null);
    expect(res.status).toBe(200);
    expect(homes).toEqual(['demo#0123456789abcdef']);
  });

  it('still serves sandbox homes only, and still caps the body', async () => {
    const { post, homes } = setup(undefined, { kind: 'platform' });
    await problem(await post({ prompt: 'Hi', home: 'home' }, null), 400, 'invalid_input');
    await problem(await post({ prompt: 'x'.repeat(5000), home: 'demo#0123456789abcdef' }, null), 413, 'payload_too_large');
    expect(homes).toEqual([]);
  });
});

describe('failures as a 200 envelope on AgentCore (G1c, approved in #17): AgentCore turns 4xx/5xx into a 424', () => {
  it('answers an agent failure as 200 + TurnFailure with the code, category, wait time and turn id', async () => {
    const { post } = setup(() => Promise.resolve(err(toolError('turn_in_progress', 'Wait.', { retryAfterMs: 7000 }))), { kind: 'platform' }, 'envelope');
    const res = await post({ prompt: 'Hi', home: 'demo#0123456789abcdef', correlationId: ID }, null);
    expect(res.status).toBe(200);
    expect(TurnFailureSchema.parse(await res.json())).toEqual({ failed: true, code: 'turn_in_progress', category: 'rate_limited', retryAfterMs: 7000, correlationId: ID });
  });

  it('answers a refused invocation the same way, so its code reaches sim-api', async () => {
    const { post } = setup(undefined, { kind: 'platform' }, 'envelope');
    const res = await post({ prompt: 'Hi', home: 'home' }, null, '/invocations', { 'x-correlation-id': ID });
    expect(res.status).toBe(200);
    expect(TurnFailureSchema.parse(await res.json())).toMatchObject({ code: 'invalid_input', category: 'validation', correlationId: ID });
  });

  it('keeps Problem Details on the local entry', async () => {
    const { post } = setup(() => Promise.resolve(err(toolError('agent_timeout', 'Too slow.'))));
    await problem(await post({ prompt: 'Hi', home: 'demo#0123456789abcdef' }), 503, 'agent_timeout');
  });
});
