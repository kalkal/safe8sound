import { InboxMessageSchema, PhoneInboxSchema, err, ok, toolError, type HomeId, type InboxMessage } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { createMcpHandler, type LogEntry } from '../src/handler.js';
import { createLocalHandler, createPhoneInboxHandler, PHONE_INBOX_PATH } from '../src/phone-inbox.js';
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
