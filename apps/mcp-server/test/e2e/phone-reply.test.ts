import { HomeIdSchema, PhoneReplyOutputSchema, SafeRoomStatusSchema } from '@cold-reserve/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { createLocalApp } from '../../src/local-app.js';
import { startNodeServer } from '../../src/node-server.js';
import { createLocalHandler, createPhoneInboxHandler, PHONE_REPLY_PATH } from '../../src/phone-inbox.js';
import { settableClock } from '../comfort-plan/support.js';
import { TOKEN } from '../helpers.js';
import { preferences } from '../storm-mode/support.js';

// Queue item 3 (#24), end to end on the local entry: in a storm the daughter's phone answers "I'm on my way",
// the agent's safe-room status says it by role; "Check status" gets the safe room; a second tap too soon is 429.

const DEMO = HomeIdSchema.parse('demo');
const PHONE = 'f'.repeat(32);

describe('the family phone replies during a storm (local entry, real HTTP)', () => {
  it('on my way → the status says it; check status → the safe room; too soon → 429 with Retry-After', async () => {
    const wall = settableClock(Date.parse('2026-10-03T10:00:00Z'));
    const env = { MCP_CLIENTS: `agent@demo=${TOKEN}, phone:daughter@demo=${PHONE}`, MCP_SCENARIO: 'storm-blackout', MCP_SCENARIO_START_H: '4' };
    const local = createLocalApp(env, { wallClock: wall, logger: { log: () => undefined } });
    if (!local.ok) throw new Error(local.error.message);
    const { app, stormMode } = local.value;
    // The person registered the daughter in the app (never through the model).
    await stormMode.storeFor(DEMO).putPreferences(preferences, []);
    const reply = app.familyReply;
    if (reply === undefined) throw new Error('no reply handler');
    const phone = createPhoneInboxHandler(app.config, { inbox: stormMode.inbox, reply, logger: { log: () => undefined } });
    const server = await startNodeServer(createLocalHandler(app.handler, phone), { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: app.config.maxBodyBytes });
    const client = new Client({ name: 'e2e-phone-reply', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }) as unknown as Transport);
    const tap = (body: unknown) =>
      fetch(new URL(PHONE_REPLY_PATH, server.url), { method: 'POST', headers: { authorization: `Bearer ${PHONE}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      await client.callTool({ name: 'start_storm_mode', arguments: { mode: 'active' } });

      const onMyWay = await tap({ reply: 'on_my_way' });
      expect(onMyWay.status).toBe(200);
      expect(PhoneReplyOutputSchema.parse(await onMyWay.json()).recorded).toMatchObject({ role: 'daughter', reply: 'on_my_way' });

      const status = await client.callTool({ name: 'get_safe_room_status', arguments: {} });
      expect(SafeRoomStatusSchema.parse(status.structuredContent).lastCheckIn).toMatchObject({ role: 'daughter', reply: 'on_my_way' });
      expect(JSON.stringify(status)).not.toMatch(/(^|[^A-Za-z])Ana([^A-Za-z]|$)|phone-/);

      const tooSoon = await tap({ reply: 'check_status' });
      expect(tooSoon.status).toBe(429);
      expect(Number(tooSoon.headers.get('retry-after'))).toBeGreaterThan(0);

      // 31 wall seconds later (the scenario clock follows the wall clock), "Check status" answers with the room.
      wall.set(wall.now() + 31_000);
      const check = await tap({ reply: 'check_status' });
      expect(check.status).toBe(200);
      const body = PhoneReplyOutputSchema.parse(await check.json());
      expect(body.status).toMatchObject({ safeRoomId: 'bedroom-1', occupantRoles: ['grandpa'], stormPhase: 'active' });
      expect(JSON.stringify(body)).not.toMatch(/(^|[^A-Za-z])Ana([^A-Za-z]|$)|phone-/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
