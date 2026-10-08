import { HomeIdSchema, toProblemDetails, toolError } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { httpPhoneInbox } from '../src/adapters/phone-http.js';

// sim-api reads a visitor sandbox's family inbox from the MCP server (#267, approved in #267): GET /phone/inbox
// with its own sandbox phone token and the sandbox in x-cold-reserve-home. The token never reaches the browser.

const HOME = HomeIdSchema.parse('demo#0123456789abcdef');
const CID = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';
const TOKEN = 'p'.repeat(40);
const message = { at: '2026-07-17T22:05:00+02:00', role: 'daughter', channel: 'in_app', transition: 'storm_started', text: 'Storm mode is on at home for Ana.' };

const port = (respond: () => Promise<Response>, timeoutMs = 1000) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const inbox = httpPhoneInbox({ mcpUrl: 'http://127.0.0.1:3316/mcp', token: TOKEN, timeoutMs, fetchFn: (url, init) => { calls.push({ url, init }); return respond(); } });
  return { inbox, calls };
};

describe('httpPhoneInbox (#267)', () => {
  it("GETs /phone/inbox on the MCP server's origin with the phone token, the sandbox and the turn id", async () => {
    const { inbox, calls } = port(() => Promise.resolve(Response.json({ messages: [message] })));
    expect(await inbox.inbox({ home: HOME, correlationId: CID })).toEqual({ ok: true, value: { messages: [message] } });
    expect(calls[0]?.url).toBe('http://127.0.0.1:3316/phone/inbox');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'x-cold-reserve-home': HOME, 'x-correlation-id': CID });
  });

  it('a refusal of the MCP server passes on by its category, with a fixed text', async () => {
    const refused = toProblemDetails(toolError('home_not_allowed', 'secret detail'), { instance: `urn:uuid:${CID}` });
    const { inbox } = port(() => Promise.resolve(Response.json(refused, { status: 403 })));
    const r = await inbox.inbox({ home: HOME, correlationId: CID });
    expect(r).toMatchObject({ ok: false, error: { category: 'internal' } });
    expect(JSON.stringify(r)).not.toContain('secret detail');
  });

  it('a rate limit passes on with its own code and wait, never as a generic 503 (#292)', async () => {
    const busy = toProblemDetails(toolError('demo_quota_exceeded', 'secret detail', { retryAfterMs: 7000 }), { instance: `urn:uuid:${CID}` });
    const { inbox } = port(() => Promise.resolve(Response.json(busy, { status: 429 })));
    const r = await inbox.inbox({ home: HOME, correlationId: CID });
    expect(r).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded', category: 'rate_limited', retryAfterMs: 7000 } });
    expect(JSON.stringify(r)).not.toContain('secret detail');
  });

  it('says a neutral text for any rate limit: the same code also means the demo is full for today (#294)', async () => {
    const full = toProblemDetails(toolError('demo_quota_exceeded', 'The demo is full for today.', { retryAfterMs: 3_600_000 }), { instance: `urn:uuid:${CID}` });
    const { inbox } = port(() => Promise.resolve(Response.json(full, { status: 429 })));
    const r = await inbox.inbox({ home: HOME, correlationId: CID });
    expect(r).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded', retryAfterMs: 3_600_000 } });
    expect(r.ok ? '' : r.error.message).not.toMatch(/too often/i);
  });

  it('a timeout, an unreachable server and a malformed body are typed errors', async () => {
    const slow = port(() => new Promise<Response>(() => undefined), 20);
    expect(await slow.inbox.inbox({ home: HOME, correlationId: CID })).toMatchObject({ ok: false, error: { code: 'store_unavailable' } });
    const down = port(() => Promise.reject(new TypeError('fetch failed')));
    expect(await down.inbox.inbox({ home: HOME, correlationId: CID })).toMatchObject({ ok: false, error: { code: 'store_unavailable' } });
    const bad = port(() => Promise.resolve(Response.json({ messages: 'nope' })));
    expect(await bad.inbox.inbox({ home: HOME, correlationId: CID })).toMatchObject({ ok: false, error: { code: 'output_schema_violation' } });
  });
});
