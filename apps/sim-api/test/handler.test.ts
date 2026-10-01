import { createHash } from 'node:crypto';
import { ProblemDetailsSchema, SessionReplySchema, err, ok, toolError, type ErrorEnvelope, type HomeId, type Result, type ToolCallReply, type TurnReply } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { loadSimApiConfig, type SimApiConfig } from '../src/config.js';
import { createSimApiHandler, type LogLine, type TurnAgentPort } from '../src/handler.js';
import { memoryQuotaStore, type QuotaStore } from '../src/quota.js';
import { signToken, verifyToken } from '../src/token.js';

const CODE = 'judges-demo-code-2026';
const ORIGIN = 'http://127.0.0.1:5400';
const KEY = Buffer.alloc(32, 7);
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

function config(over: Record<string, string> = {}): SimApiConfig {
  const result = loadSimApiConfig({
    SIM_DEMO_CODES: `judges:${createHash('sha256').update(CODE).digest('hex')}`,
    SIM_TOKEN_KEYS: `k1:${KEY.toString('base64url')}`,
    SIM_ALLOWED_ORIGINS: ORIGIN,
    SIM_LIMIT_TURNS_PER_CODE: '2',
    SIM_LIMIT_FAILED_CODES_PER_IP_HOUR: '2',
    ...over,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Fault injection: a throwing agent or quota store, a failing card tool. */
interface Faults {
  readonly ask?: TurnAgentPort['ask'];
  readonly toolReply?: Result<ToolCallReply, ErrorEnvelope>;
  readonly quota?: QuotaStore;
}

function setup(over: Record<string, string> = {}, agentReply?: Result<TurnReply, ErrorEnvelope>, faults: Faults = {}) {
  const asked: { home: HomeId; question: string; correlationId: string }[] = [];
  const called: { home: HomeId; name: string }[] = [];
  const logs: LogLine[] = [];
  let homes = 0;
  const handler = createSimApiHandler(config(over), {
    agent: {
      ask: (input) => {
        if (faults.ask) return faults.ask(input);
        asked.push(input);
        return Promise.resolve(agentReply ?? ok({ text: 'Your battery is at 45%.' }));
      },
    },
    tools: {
      call: (input) => {
        called.push({ home: input.home, name: input.request.name });
        return Promise.resolve(faults.toolReply ?? ok<ToolCallReply>({ content: [{ type: 'text', text: 'Applied.' }], structuredContent: { ok: true } }));
      },
    },
    quota: faults.quota ?? memoryQuotaStore(),
    clock: { now: () => NOW },
    randomHex: () => `${String(++homes).padStart(2, '0')}${'a'.repeat(14)}`,
    logger: { log: (line) => logs.push(line) },
  });
  const send = (path: string, init: { method?: string; body?: unknown; token?: string; origin?: string | null; headers?: Record<string, string> } = {}) =>
    handler(
      new Request(`http://127.0.0.1:3341${path}`, {
        method: init.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          ...(init.origin === null ? {} : { origin: init.origin ?? ORIGIN }),
          ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
      }),
      { clientIp: '203.0.113.7' },
    );
  const session = async () => SessionReplySchema.parse(await (await send('/v1/session', { body: { code: CODE } })).json()).token;
  return { send, session, asked, called, logs };
}

async function problem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain('application/problem+json');
  const body = ProblemDetailsSchema.parse(await res.json());
  expect(body.code).toBe(code);
  return body;
}

describe('POST /v1/session: a demo code for a 1-hour token', () => {
  it('answers a token for a fresh sandbox home, expiring in one hour', async () => {
    const { send } = setup();
    const res = await send('/v1/session', { body: { code: CODE } });
    expect(res.status).toBe(200);
    const reply = SessionReplySchema.parse(await res.json());
    expect(reply.expiresAt).toBe(new Date(NOW + 3_600_000).toISOString());
    const claims = verifyToken(reply.token, { keys: [{ kid: 'k1', material: KEY }], nowS: NOW / 1000, skewS: 30 });
    expect(claims).toMatchObject({ ok: true, value: { sub: 'judges', home: 'demo#01aaaaaaaaaaaaaa' } });
  });

  it('refuses a wrong code with invalid_demo_code, then caps the attempts per IP', async () => {
    const { send } = setup();
    const wrong = { body: { code: 'not-the-demo-code-at-all' } };
    const first = await problem(await send('/v1/session', wrong), 401, 'invalid_demo_code');
    expect(first.detail).not.toMatch(/judges/);
    await problem(await send('/v1/session', wrong), 401, 'invalid_demo_code');
    await problem(await send('/v1/session', { body: { code: CODE } }), 429, 'demo_quota_exceeded');
  });
});

describe('POST /v1/turns: the agent behind the token', () => {
  it('asks the agent for the home in the token and answers its reply', async () => {
    const { send, session, asked } = setup();
    const res = await send('/v1/turns', { token: await session(), body: { question: "What's my battery level?" }, headers: { 'x-correlation-id': '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Your battery is at 45%.' });
    expect(asked).toEqual([{ home: 'demo#01aaaaaaaaaaaaaa', question: "What's my battery level?", correlationId: '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60' }]);
    expect(res.headers.get('x-correlation-id')).toBe('0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60');
  });

  it('keeps each visitor in their own sandbox: a token never reaches another home', async () => {
    const { send, session, asked } = setup();
    const [a, b] = [await session(), await session()];
    await send('/v1/turns', { token: a, body: { question: 'A?' } });
    await send('/v1/turns', { token: b, body: { question: 'B?' } });
    expect(asked.map((x) => x.home)).toEqual(['demo#01aaaaaaaaaaaaaa', 'demo#02aaaaaaaaaaaaaa']);
  });

  it('refuses a body that names a home', async () => {
    const { send, session } = setup();
    await problem(await send('/v1/turns', { token: await session(), body: { question: 'Hi', homeId: 'home' } }), 400, 'invalid_input');
  });

  it('answers 401 missing_token with WWW-Authenticate without a token', async () => {
    const { send } = setup();
    const res = await send('/v1/turns', { body: { question: 'Hi' } });
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    await problem(res, 401, 'missing_token');
  });

  it('answers 401 invalid_signature to a forged token and signature_expired to an old one', async () => {
    const { send } = setup();
    const base = { sub: 'judges', home: 'demo#ffffffffffffffff' as HomeId, jti: 'x' };
    const forged = signToken({ ...base, iat: NOW / 1000, exp: NOW / 1000 + 3600 }, { kid: 'k1', material: Buffer.alloc(32, 9) });
    await problem(await send('/v1/turns', { token: forged, body: { question: 'Hi' } }), 401, 'invalid_signature');
    const old = signToken({ ...base, iat: NOW / 1000 - 7200, exp: NOW / 1000 - 3600 }, { kid: 'k1', material: KEY });
    await problem(await send('/v1/turns', { token: old, body: { question: 'Hi' } }), 401, 'signature_expired');
  });

  it('refuses over the daily cap BEFORE calling the agent', async () => {
    const { send, session, asked } = setup();
    const token = await session();
    await send('/v1/turns', { token, body: { question: '1' } });
    await send('/v1/turns', { token, body: { question: '2' } });
    const body = await problem(await send('/v1/turns', { token, body: { question: '3' } }), 429, 'demo_quota_exceeded');
    expect(body.retryAfterMs).toBe(12 * 3_600_000);
    expect(asked).toHaveLength(2);
  });

  it('passes agent failures on as Problem Details (agent_timeout -> 503)', async () => {
    const { send, session } = setup({}, err(toolError('agent_timeout', 'The assistant took too long.')));
    await problem(await send('/v1/turns', { token: await session(), body: { question: 'Hi' } }), 503, 'agent_timeout');
  });
});

describe('POST /v1/tools/call: card actions, the MCP token stays here', () => {
  it('forwards a card action for the home in the token', async () => {
    const { send, session, called } = setup();
    const res = await send('/v1/tools/call', { token: await session(), body: { name: 'apply_plan', arguments: { planId: 'plan-0001' } } });
    expect(res.status).toBe(200);
    expect(called).toEqual([{ home: 'demo#01aaaaaaaaaaaaaa', name: 'apply_plan' }]);
  });

  it('refuses any tool that is not a card action', async () => {
    const { send, session, called } = setup();
    await problem(await send('/v1/tools/call', { token: await session(), body: { name: 'notify_family', arguments: {} } }), 400, 'invalid_input');
    expect(called).toEqual([]);
  });
});

describe('transport rules', () => {
  it('refuses a foreign Origin with 403 and no CORS headers', async () => {
    const { send } = setup();
    const res = await send('/v1/session', { body: { code: CODE }, origin: 'https://evil.example' });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    await problem(res, 403, 'origin_not_allowed');
  });

  it('answers the CORS preflight of the simulator origin only', async () => {
    const { send } = setup();
    const res = await send('/v1/turns', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('answers 405 to GET, 404 to an unknown path, 413 to a large body', async () => {
    const { send } = setup();
    await problem(await send('/v1/turns', { method: 'GET' }), 405, 'method_not_allowed');
    await problem(await send('/v1/other', { body: {} }), 404, 'route_not_found');
    await problem(await send('/v1/session', { body: { code: 'x'.repeat(40_000) } }), 413, 'payload_too_large');
  });

  it('answers 403 demo_disabled everywhere when the kill switch is off', async () => {
    const { send } = setup({ SIM_DEMO_ENABLED: 'false' });
    await problem(await send('/v1/session', { body: { code: CODE } }), 403, 'demo_disabled');
  });

  it('never logs the demo code or the token', async () => {
    const { send, session, logs } = setup();
    const token = await session();
    await send('/v1/session', { body: { code: 'not-the-demo-code-at-all' } });
    await send('/v1/turns', { token: `${token}x`, body: { question: 'Hi' } });
    const text = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(0);
    expect(text).not.toContain(CODE);
    expect(text).not.toContain('not-the-demo-code-at-all');
    expect(text).not.toContain(token);
  });
});

describe('refusals (review of #110)', () => {
  it('refuses Origin "null" (sandboxed iframes, file://) and a lookalike origin', async () => {
    const { send } = setup();
    await problem(await send('/v1/session', { body: { code: CODE }, origin: 'null' }), 403, 'origin_not_allowed');
    await problem(await send('/v1/session', { body: { code: CODE }, origin: `${ORIGIN}.evil.example` }), 403, 'origin_not_allowed');
    await problem(await send('/v1/session', { body: { code: CODE }, origin: 'http://127.0.0.1:54000' }), 403, 'origin_not_allowed');
  });

  it('serves a request without Origin, with no CORS headers: browsers always send one, the token is the access control', async () => {
    const { send } = setup();
    const res = await send('/v1/session', { body: { code: CODE }, origin: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers 400 invalid_input to a body that is not JSON', async () => {
    const { send } = setup();
    await problem(await send('/v1/session', { body: '{"code": ' }), 400, 'invalid_input');
  });

  it('answers 400 invalid_input to a bad session body, without spending an attempt of the IP', async () => {
    const { send } = setup();
    for (const body of [{}, { code: 'short' }, { code: CODE, extra: true }, [CODE]]) {
      await problem(await send('/v1/session', { body }), 400, 'invalid_input');
    }
    expect((await send('/v1/session', { body: { code: CODE } })).status).toBe(200);
  });

  it('caps the card tool calls per code: 429 before calling the tool', async () => {
    const { send, session, called } = setup({ SIM_LIMIT_TOOL_CALLS_PER_CODE: '1' });
    const token = await session();
    const call = { token, body: { name: 'apply_plan', arguments: { planId: 'plan-0001' } } };
    expect((await send('/v1/tools/call', call)).status).toBe(200);
    await problem(await send('/v1/tools/call', call), 429, 'demo_quota_exceeded');
    expect(called).toHaveLength(1);
  });

  it('passes a card tool failure on as Problem Details (agent_unavailable -> 503)', async () => {
    const { send, session, logs } = setup({}, undefined, { toolReply: err(toolError('agent_unavailable', 'The home could not be reached.')) });
    await problem(await send('/v1/tools/call', { token: await session(), body: { name: 'apply_plan', arguments: { planId: 'plan-0001' } } }), 503, 'agent_unavailable');
    expect(logs).toMatchObject([{ level: 'warn', code: 'agent_unavailable', codeId: 'judges' }]);
  });

  it('answers 403 demo_disabled on /v1/turns too, before reading the token', async () => {
    const { send, asked } = setup({ SIM_DEMO_ENABLED: 'false' });
    await problem(await send('/v1/turns', { token: 'whatever', body: { question: 'Hi' } }), 403, 'demo_disabled');
    expect(asked).toEqual([]);
  });
});

describe('last resort (review of #110): a throw never escapes the handler', () => {
  const ID = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';

  it('maps a throwing agent to 500 unexpected_error with the correlation id, and logs the error name at error level', async () => {
    const { send, session, logs } = setup({}, undefined, { ask: () => Promise.reject(new TypeError('agent exploded: token=abc')) });
    const res = await send('/v1/turns', { token: await session(), body: { question: 'Hi' }, headers: { 'x-correlation-id': ID } });
    const body = await problem(res, 500, 'unexpected_error');
    expect(body.instance).toBe(`urn:uuid:${ID}`);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(JSON.stringify(body)).not.toContain('exploded');
    expect(logs).toMatchObject([{ level: 'error', component: 'sim-api', code: 'unexpected_error', category: 'internal', correlationId: ID, errorName: 'TypeError', codeId: 'judges' }]);
    expect(JSON.stringify(logs)).not.toContain('token=abc');
  });

  it('keeps the cause chain by name: a wrapped store error logs both names', async () => {
    const failing: QuotaStore = {
      consume: () => Promise.reject(new Error('quota store down', { cause: Object.assign(new Error('x'), { name: 'ProvisionedThroughputExceededException' }) })),
      peek: () => Promise.resolve(0),
    };
    const { send, logs } = setup({}, undefined, { quota: failing });
    const token = signToken({ sub: 'judges', home: 'demo#01aaaaaaaaaaaaaa' as HomeId, iat: NOW / 1000, exp: NOW / 1000 + 3600, jti: 'j' }, { kid: 'k1', material: KEY });
    await problem(await send('/v1/turns', { token, body: { question: 'Hi' } }), 500, 'unexpected_error');
    expect(logs).toMatchObject([{ code: 'unexpected_error', errorName: 'Error', causeName: 'ProvisionedThroughputExceededException' }]);
  });

  it('maps a throwing quota store on /v1/session to 500 too', async () => {
    const throwing: QuotaStore = { consume: () => Promise.reject(new RangeError('x')), peek: () => Promise.reject(new RangeError('x')) };
    const { send } = setup({}, undefined, { quota: throwing });
    await problem(await send('/v1/session', { body: { code: CODE } }), 500, 'unexpected_error');
  });
});
