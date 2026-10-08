import { InboxMessageSchema, PhoneInboxSchema, PhoneReplyOutputSchema, err, ok, toolError, type HomeId, type InboxMessage } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { createMcpHandler, type LogEntry } from '../src/handler.js';
import { createLocalHandler, createPhoneInboxHandler, PHONE_INBOX_PATH, PHONE_REPLY_PATH, type PhoneReplyHandler } from '../src/phone-inbox.js';
import { createRegistry } from '../src/registry.js';
import { ALLOWED_ORIGIN, HOME_TOKEN, TOKEN, homeId, probeModule, testConfig } from './helpers.js';

// GET /phone/inbox (#24): the family phone reads the delivered messages. Only a phone-scoped token,
// never the agent's; the home comes from the token; no MCP tool ever exposes the inbox.

const PHONE_TOKEN = 'p'.repeat(32);
const URL_INBOX = `http://127.0.0.1:3316${PHONE_INBOX_PATH}`;

const message = (at: string, text: string): InboxMessage =>
  InboxMessageSchema.parse({ at, role: 'daughter', channel: 'in_app', transition: 'storm_started', text });

function setup(inbox: (h: HomeId) => ReturnType<Parameters<typeof createPhoneInboxHandler>[1]['inbox']> = (h) =>
  Promise.resolve(ok(h === homeId('demo') ? [message('2026-07-17T15:31:00Z', 'newer'), message('2026-07-17T15:30:00Z', 'older')] : []))) {
  const logs: LogEntry[] = [];
  const config = testConfig({ clients: new Map([...testConfig().clients, [PHONE_TOKEN, { clientId: 'family', homeId: homeId('demo'), scope: 'phone' as const }]]) });
  const phone = createPhoneInboxHandler(config, { inbox, logger: { log: (e) => logs.push(e) } });
  const registry = createRegistry([probeModule]);
  if (!registry.ok) throw new Error(registry.error.message);
  const mcp = createMcpHandler(config, { registry: registry.value, logger: { log: (e) => logs.push(e) } });
  return { handle: createLocalHandler(mcp, phone), logs };
}

const get = (handle: (r: Request) => Promise<Response>, headers: Record<string, string> = {}, method = 'GET') => handle(new Request(URL_INBOX, { method, headers }));
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('GET /phone/inbox', () => {
  it('gives the phone token the messages of its home, newest first, never cached', async () => {
    const { handle } = setup();
    const res = await get(handle, bearer(PHONE_TOKEN));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(PhoneInboxSchema.parse(await res.json()).messages.map((m) => m.text)).toEqual(['newer', 'older']);
  });

  it('refuses a request without a token (401)', async () => {
    const res = await get(setup().handle);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'missing_token' });
  });

  it.each([
    ['the agent token', TOKEN],
    ['another MCP client token', HOME_TOKEN],
    ['a token nobody was issued', 'x'.repeat(32)],
  ])('refuses %s (401): the inbox is for the phone only', async (_name, token) => {
    const { handle, logs } = setup();
    const res = await get(handle, bearer(token));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'wrong_client' });
    expect(logs.at(-1)).toMatchObject({ code: 'wrong_client' });
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it('refuses the phone token on the MCP endpoint (401): it cannot reach any tool', async () => {
    const { handle } = setup();
    const res = await handle(
      new Request('http://127.0.0.1:3316/mcp', {
        method: 'POST',
        headers: { ...bearer(PHONE_TOKEN), 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'wrong_client' });
  });

  it('refuses the phone token on the MCP endpoint before any sandbox logic, even naming a sandbox home', async () => {
    const { handle } = setup();
    const res = await handle(
      new Request('http://127.0.0.1:3316/mcp', {
        method: 'POST',
        headers: {
          ...bearer(PHONE_TOKEN),
          'x-cold-reserve-home': 'demo#0123456789abcdef',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'wrong_client' });
  });

  it("logs with the phone's correlation id when it sends one, so both sides share it", async () => {
    const { handle, logs } = setup(() => Promise.resolve(err(toolError('store_unavailable', 'The table is down.'))));
    const id = '0f8f8a3e-6a5b-4c1d-9e2f-1234567890ab';
    await get(handle, { ...bearer(PHONE_TOKEN), 'x-correlation-id': id });
    expect(logs.at(-1)).toMatchObject({ code: 'store_unavailable', correlationId: id });
    await get(handle, { ...bearer(PHONE_TOKEN), 'x-correlation-id': 'not-a-uuid' });
    expect(logs.at(-1)?.correlationId).not.toBe('not-a-uuid');
  });

  it('accepts GET only', async () => {
    const res = await get(setup().handle, bearer(PHONE_TOKEN), 'POST');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, OPTIONS');
  });

  it('serves a browser phone only from an allowed Origin, with CORS for it', async () => {
    const { handle } = setup();
    const refused = await get(handle, { ...bearer(PHONE_TOKEN), origin: 'https://evil.example' });
    expect(refused.status).toBe(403);
    const allowed = await get(handle, { ...bearer(PHONE_TOKEN), origin: ALLOWED_ORIGIN });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(allowed.headers.get('vary')).toBe('Origin');
    const preflight = await get(handle, { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'GET' }, 'OPTIONS');
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization');
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET');
  });

  it('says the store is unavailable as Problem Details (503), and logs it', async () => {
    const { handle, logs } = setup(() => Promise.resolve(err(toolError('store_unavailable', 'The table is down.'))));
    const res = await get(handle, bearer(PHONE_TOKEN));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'store_unavailable' });
    expect(logs.at(-1)).toMatchObject({ code: 'store_unavailable', clientId: 'family', homeId: 'demo' });
  });

  it('leaves every other path to the MCP handler', async () => {
    const res = await setup().handle(new Request('http://127.0.0.1:3316/elsewhere'));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'route_not_found' });
  });
});

describe('POST /phone/reply (queue item 3, #24): the family phone answers with a closed set of replies', () => {
  const URL_REPLY = `http://127.0.0.1:3316${PHONE_REPLY_PATH}`;
  const recorded = { role: 'family', reply: 'on_my_way' as const, at: '2026-07-17T15:40:00.000Z' };

  function withReply(reply: PhoneReplyHandler = (input, ctx) => Promise.resolve(ok({ recorded: { ...recorded, role: ctx.clientId, reply: input.reply } }))) {
    const logs: LogEntry[] = [];
    const calls: { input: unknown; ctx: unknown }[] = [];
    const config = testConfig({ clients: new Map([...testConfig().clients, [PHONE_TOKEN, { clientId: 'family', homeId: homeId('demo'), scope: 'phone' as const }]]) });
    const phone = createPhoneInboxHandler(config, {
      inbox: () => Promise.resolve(ok([])),
      reply: (input, ctx) => {
        calls.push({ input, ctx });
        return reply(input, ctx);
      },
      logger: { log: (e) => logs.push(e) },
    });
    const registry = createRegistry([probeModule]);
    if (!registry.ok) throw new Error(registry.error.message);
    const mcp = createMcpHandler(config, { registry: registry.value, logger: { log: (e) => logs.push(e) } });
    return { handle: createLocalHandler(mcp, phone), logs, calls };
  }
  const post = (handle: (r: Request) => Promise<Response>, body: string, headers: Record<string, string> = {}) =>
    handle(new Request(URL_REPLY, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } }));

  it('records the reply for the role of the phone token, never a role from the body', async () => {
    const { handle, calls } = withReply();
    const res = await post(handle, JSON.stringify({ reply: 'on_my_way' }), bearer(PHONE_TOKEN));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(PhoneReplyOutputSchema.parse(await res.json()).recorded).toMatchObject({ role: 'family', reply: 'on_my_way' });
    expect(calls[0]?.ctx).toMatchObject({ clientId: 'family', homeId: 'demo' });
    const spoofed = await post(handle, JSON.stringify({ reply: 'on_my_way', role: 'son' }), bearer(PHONE_TOKEN));
    expect(spoofed.status).toBe(400);
  });

  it('refuses free text, an unknown reply, a body that is not JSON, or one too large (400), before any call', async () => {
    const { handle, calls } = withReply();
    // The last body is schema-valid but over 256 bytes: only the size check refuses it.
    for (const body of [JSON.stringify({ reply: 'call me' }), 'not json', `${JSON.stringify({ reply: 'on_my_way' })}${' '.repeat(300)}`]) {
      const res = await post(handle, body, bearer(PHONE_TOKEN));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_input' });
    }
    expect(calls).toEqual([]);
  });

  it('only for a phone token: the agent token is refused, as on the inbox', async () => {
    const { handle, calls } = withReply();
    expect((await post(handle, JSON.stringify({ reply: 'on_my_way' }))).status).toBe(401);
    const agent = await post(handle, JSON.stringify({ reply: 'on_my_way' }), bearer(TOKEN));
    expect(agent.status).toBe(401);
    expect(await agent.json()).toMatchObject({ code: 'wrong_client' });
    expect(calls).toEqual([]);
  });

  it('a reply too soon is 429 with Retry-After, as Problem Details, and logged with the code', async () => {
    const { handle, logs } = withReply(() => Promise.resolve(err(toolError('family_reply_rate_limited', 'Too soon.', { retryAfterMs: 20_000 }))));
    const res = await post(handle, JSON.stringify({ reply: 'check_status' }), bearer(PHONE_TOKEN));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('20');
    expect(await res.json()).toMatchObject({ code: 'family_reply_rate_limited' });
    expect(logs.at(-1)).toMatchObject({ code: 'family_reply_rate_limited', clientId: 'family' });
  });

  it('accepts POST only on the reply path, with a CORS preflight for an allowed Origin', async () => {
    const { handle } = withReply();
    const res = await handle(new Request(URL_REPLY, { method: 'GET', headers: bearer(PHONE_TOKEN) }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST, OPTIONS');
    const preflight = await handle(new Request(URL_REPLY, { method: 'OPTIONS', headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'POST' } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
  });

  it('without a reply function (no storm module) the path is not served', async () => {
    const { handle } = setup();
    const res = await handle(new Request(URL_REPLY, { method: 'POST', body: '{}', headers: bearer(PHONE_TOKEN) }));
    expect(res.status).toBe(404);
  });
});

describe('GET /phone/inbox for visitor sandboxes (#267, approved in #267)', () => {
  const SANDBOX_PHONE = 's'.repeat(32);
  const SANDBOX = 'demo#0123456789abcdef';
  const setupSandbox = () => {
    const logs: LogEntry[] = [];
    const read: HomeId[] = [];
    const admitted: HomeId[] = [];
    const config = testConfig({ clients: new Map([...testConfig().clients, [SANDBOX_PHONE, { clientId: 'daughter', homeId: homeId('demo'), sandboxes: true as const, scope: 'phone' as const }], [PHONE_TOKEN, { clientId: 'family', homeId: homeId('demo'), scope: 'phone' as const }]]) });
    const phone = createPhoneInboxHandler(config, {
      inbox: (h) => {
        read.push(h);
        return Promise.resolve(ok([message('2026-07-17T22:05:00+02:00', 'Storm mode is on at home for Ana.')]));
      },
      admit: (h) => {
        admitted.push(h);
        return Promise.resolve(ok(undefined));
      },
      logger: { log: (e) => logs.push(e) },
    });
    return { phone, logs, read, admitted };
  };
  const at = (handle: (r: Request) => Promise<Response>, headers: Record<string, string>, method = 'GET') => handle(new Request(URL_INBOX, { method, headers }));

  it("reads the named sandbox's inbox, after admitting it so its playthrough is the right one; logs the read without the id or the text", async () => {
    const { phone, logs, read, admitted } = setupSandbox();
    const res = await at(phone, { ...bearer(SANDBOX_PHONE), 'x-cold-reserve-home': SANDBOX });
    expect(res.status).toBe(200);
    expect(PhoneInboxSchema.parse(await res.json()).messages).toHaveLength(1);
    expect(read).toEqual([SANDBOX]);
    expect(admitted).toEqual([SANDBOX]);
    expect(logs).toContainEqual(expect.objectContaining({ level: 'info', message: 'phone_inbox_read', details: expect.objectContaining({ home: 'sandbox', messages: 1 }) as unknown }));
    expect(JSON.stringify(logs)).not.toContain(SANDBOX);
    expect(JSON.stringify(logs)).not.toContain('Ana');
  });

  it.each([
    ['no home header', {}],
    ['demo itself', { 'x-cold-reserve-home': 'demo' }],
    ['the real home', { 'x-cold-reserve-home': 'home' }],
    ['a malformed sandbox id', { 'x-cold-reserve-home': 'demo#xyz' }],
  ])('a sandbox phone token refuses %s (home_not_allowed), reading nothing', async (_case, headers) => {
    const { phone, read } = setupSandbox();
    const res = await at(phone, { ...bearer(SANDBOX_PHONE), ...headers });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'home_not_allowed' });
    expect(read).toEqual([]);
  });

  it("a one-home phone token may not name another home", async () => {
    const { phone, read } = setupSandbox();
    const res = await at(phone, { ...bearer(PHONE_TOKEN), 'x-cold-reserve-home': SANDBOX });
    expect(res.status).toBe(403);
    expect(read).toEqual([]);
  });

  it("a sandbox phone's error lines never say demo: the sandbox as `sandbox`, never its id (#292)", async () => {
    const logs: LogEntry[] = [];
    const config = testConfig({ clients: new Map([...testConfig().clients, [SANDBOX_PHONE, { clientId: 'daughter', homeId: homeId('demo'), sandboxes: true as const, scope: 'phone' as const }]]) });
    const phone = createPhoneInboxHandler(config, {
      inbox: () => Promise.resolve(err(toolError('store_unavailable', 'Down.'))),
      admit: () => Promise.resolve(ok(undefined)),
      logger: { log: (e) => logs.push(e) },
    });
    await at(phone, { ...bearer(SANDBOX_PHONE), 'x-cold-reserve-home': SANDBOX });
    await at(phone, { ...bearer(SANDBOX_PHONE), 'x-cold-reserve-home': 'demo' });
    const errors = logs.filter((l) => l.level !== 'info');
    expect(errors.map((l) => l.code)).toEqual(['store_unavailable', 'home_not_allowed']);
    for (const line of errors) expect(line).not.toHaveProperty('homeId');
    expect(errors[0]?.details).toMatchObject({ home: 'sandbox' });
    expect(JSON.stringify(logs)).not.toContain(SANDBOX);
  });

  it('a sandbox phone is read-only: it cannot reply', async () => {
    const { phone } = setupSandbox();
    const res = await phone(new Request(`http://127.0.0.1:3316${PHONE_REPLY_PATH}`, { method: 'POST', headers: { ...bearer(SANDBOX_PHONE), 'x-cold-reserve-home': SANDBOX, 'content-type': 'application/json' }, body: '{"reply":"on_my_way"}' }));
    expect(res.status).toBe(404);
  });
});
