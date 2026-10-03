import { PlanSchema, SafeRoomStatusSchema } from '@cold-reserve/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { createLocalApp } from '../../src/local-app.js';
import { startNodeServer } from '../../src/node-server.js';
import { settableClock } from '../comfort-plan/support.js';
import { TOKEN } from '../helpers.js';

// One physics for "safe until" (Q7-A of #24): on the storm-blackout night with a low battery, the storm card
// and the last-resort plan name the same time. Both read the guard's hold of the safe room (holdSafeRoom).

describe('the storm card and the last-resort plan agree on "safe until"', () => {
  it('storm-blackout hour 8, battery 30 % at the scenario start (16 % now), grandpa: the same safe-until, 22:00', async () => {
    const wall = settableClock(Date.parse('2026-10-03T10:00:00Z'));
    const env = { MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_SCENARIO: 'storm-blackout', MCP_SCENARIO_START_H: '8', MCP_SCENARIO_START_SOC_PCT: '30' };
    const local = createLocalApp(env, { wallClock: wall, logger: { log: () => undefined } });
    if (!local.ok) throw new Error(local.error.message);
    const server = await startNodeServer(local.value.app.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: local.value.app.config.maxBodyBytes });
    const client = new Client({ name: 'e2e-agreement', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }) as unknown as Transport);
    try {
      const status = SafeRoomStatusSchema.parse((await client.callTool({ name: 'get_safe_room_status', arguments: {} })).structuredContent);
      expect(status.occupantRoles).toContain('grandpa');
      const plan = PlanSchema.parse((await client.callTool({ name: 'plan_comfort', arguments: { goal: 'cool' } })).structuredContent);
      expect(plan.lastResort).toMatchObject({ limitedBy: 'battery' });
      expect(status.safeUntil).toBe(plan.lastResort?.safeUntil);
      // Pinned: both name 22:00 local, two hours on; the plan runs out of battery by then.
      expect(status.safeUntil).toMatch(/T22:00:00\+02:00$/);
      expect(status.safeHours).toBe(2);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
