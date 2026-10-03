import { PlanSchema, SafeRoomStatusSchema, type Plan, type SafeRoomStatus } from '@cold-reserve/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { createLocalApp } from '../../src/local-app.js';
import { startNodeServer } from '../../src/node-server.js';
import { settableClock } from '../comfort-plan/support.js';
import { TOKEN } from '../helpers.js';

// One physics for "safe until" (Q7-A of #24): the storm card reads the guard's hold of the safe room
// (holdSafeRoom), pre-cooled toward the night limit; the last-resort plan reads the same engine and limits.
// The battery level is set at the scenario start (hour 0): by hour 8, 30 % has become 16 %.

/** The storm card and a plan_comfort answer at a scenario start hour and start battery level, on the local entry. */
async function at(startH: number, startSocPct: number): Promise<{ status: SafeRoomStatus; plan: Plan }> {
  const wall = settableClock(Date.parse('2026-10-03T10:00:00Z'));
  const env = { MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_SCENARIO: 'storm-blackout', MCP_SCENARIO_START_H: String(startH), MCP_SCENARIO_START_SOC_PCT: String(startSocPct) };
  const local = createLocalApp(env, { wallClock: wall, logger: { log: () => undefined } });
  if (!local.ok) throw new Error(local.error.message);
  const server = await startNodeServer(local.value.app.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: local.value.app.config.maxBodyBytes });
  const client = new Client({ name: 'e2e-agreement', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }) as unknown as Transport);
  try {
    const status = SafeRoomStatusSchema.parse((await client.callTool({ name: 'get_safe_room_status', arguments: {} })).structuredContent);
    const plan = PlanSchema.parse((await client.callTool({ name: 'plan_comfort', arguments: { goal: 'cool' } })).structuredContent);
    return { status, plan };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('the storm card and the last-resort plan on one physics', () => {
  it('hour 8, 30 % at the start (16 % now), grandpa: both name 22:00, two hours on', async () => {
    const { status, plan } = await at(8, 30);
    expect(status.occupantRoles).toContain('grandpa');
    expect(plan.lastResort).toMatchObject({ limitedBy: 'battery' });
    expect(status.safeUntil).toBe(plan.lastResort?.safeUntil);
    expect(status.safeUntil).toMatch(/T22:00:00\+02:00$/);
    expect(status.safeHours).toBe(2);
  });

  it('hour 4, 50 %: a plan keeps him safe (no last resort), and the storm card does not stop at 22:00', async () => {
    const { status, plan } = await at(4, 50);
    expect(plan.lastResort).toBeUndefined();
    expect(plan.guarantees.every((g) => g.ok)).toBe(true);
    // Pre-cooled toward the 24 °C night limit, the battery holds the safe room through the 24-hour cap.
    expect(status.safeHours).toBe(24);
  });

  it('hour 4, 30 %: pre-cooled, the storm card holds past midnight (01:20), never earlier than the last resort', async () => {
    const { status, plan } = await at(4, 30);
    expect(status.safeUntil).toMatch(/T01:20:00\+02:00$/);
    const lastResort = plan.lastResort?.safeUntil;
    expect(lastResort).toBeDefined();
    // Until the last resort becomes the hold itself (next PR), the card is the better of the two.
    expect(Date.parse(status.safeUntil)).toBeGreaterThanOrEqual(Date.parse(lastResort ?? ''));
  });
});
