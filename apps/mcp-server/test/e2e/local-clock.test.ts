import { ApplyPlanOutputSchema, PlanSchema, ReserveOutlookSchema, SafeRoomStatusSchema } from '@cold-reserve/contracts';
import { builtInScenario } from '@cold-reserve/source-simulator';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { createLocalApp } from '../../src/local-app.js';
import { startNodeServer } from '../../src/node-server.js';
import { settableClock } from '../comfort-plan/support.js';
import { TOKEN } from '../helpers.js';

// The local entry on one clock (#160, the end-to-end acceptance test): the real time is October, the scenario is a July
// day. The simulator, the plans, the storm sessions and the store all run on the scenario clock, so a plan is
// made "now" in the scenario, expires ten scenario minutes later, and the safe hours count from scenario time.

const H = 3_600_000;
const textOf = (r: Record<string, unknown>): string => (r['content'] as { type: string; text: string }[] | undefined)?.[0]?.text ?? '';

describe('local entry: one scenario clock for everything', () => {
  it('plans, storm status and the outlook speak scenario time, in the home zone; a plan made now can be applied', async () => {
    const wall = settableClock(Date.parse('2026-10-03T10:00:00Z'));
    const env = { MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_SCENARIO: 'storm-blackout', MCP_SCENARIO_START_H: '4' };
    const local = createLocalApp(env, { wallClock: wall, logger: { log: () => undefined } });
    if (!local.ok) throw new Error(local.error.message);
    const { app } = local.value;
    const server = await startNodeServer(app.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: app.config.maxBodyBytes });
    const client = new Client({ name: 'e2e-local-clock', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }) as unknown as Transport);
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const scenarioNow = Date.parse(builtInScenario('storm-blackout').startAt) + 4 * H;
    try {
      const planned = await call('plan_comfort', { goal: 'cool' });
      const plan = PlanSchema.parse(planned.structuredContent);
      expect(Math.abs(Date.parse(plan.createdAt) - scenarioNow)).toBeLessThan(60_000);
      expect(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt)).toBe(10 * 60_000);
      // The horizon as the person hears it, in the home's zone, never in UTC.
      expect(plan.horizonAt).toMatch(/\+02:00$/);
      expect(textOf(planned)).not.toMatch(/until 2026-\d\d-\d\dT[\d:.]+Z/);

      const applied = await call('apply_plan', { planId: plan.id });
      expect(applied.isError).not.toBe(true);
      expect(ApplyPlanOutputSchema.parse(applied.structuredContent).plan.id).toBe(plan.id);

      const status = SafeRoomStatusSchema.parse((await call('get_safe_room_status')).structuredContent);
      expect(status.safeUntil.startsWith('2026-07-')).toBe(true);
      expect(Date.parse(status.safeUntil)).toBeGreaterThanOrEqual(scenarioNow);

      const outlook = await call('get_reserve_outlook');
      expect(ReserveOutlookSchema.parse(outlook.structuredContent).ts).toMatch(/^2026-07-17T16:0\d:\d\d\+02:00$/);
      expect(textOf(outlook)).toMatch(/As of 16:0\d \(/);
      expect(textOf(outlook)).not.toMatch(/\d{4}-\d\d-\d\dT/);
      expect(textOf(planned)).not.toMatch(/\d{4}-\d\d-\d\dT/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('a local-only start battery level reaches the last resort in the storm; a bad value stops the start', async () => {
    const wall = settableClock(Date.parse('2026-10-03T10:00:00Z'));
    const env = { MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_SCENARIO: 'storm-blackout', MCP_SCENARIO_START_H: '4', MCP_SCENARIO_START_SOC_PCT: '20' };
    const local = createLocalApp(env, { wallClock: wall, logger: { log: () => undefined } });
    if (!local.ok) throw new Error(local.error.message);
    const server = await startNodeServer(local.value.app.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: local.value.app.config.maxBodyBytes });
    const client = new Client({ name: 'e2e-local-soc', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }) as unknown as Transport);
    try {
      const home = await client.callTool({ name: 'get_home_status', arguments: {} });
      expect((home.structuredContent as { batterySocPct: number }).batterySocPct).toBeLessThanOrEqual(40);
      const plan = PlanSchema.parse((await client.callTool({ name: 'plan_comfort', arguments: { goal: 'cool' } })).structuredContent);
      expect(plan.lastResort).toBeDefined();
    } finally {
      await client.close();
      await server.close();
    }
    // The control case: the scenario's own 85 % at the start gives an ordinary plan, no last resort.
    const normal = createLocalApp({ ...env, MCP_SCENARIO_START_SOC_PCT: '' }, { wallClock: wall, logger: { log: () => undefined } });
    if (!normal.ok) throw new Error(normal.error.message);
    const s2 = await startNodeServer(normal.value.app.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: normal.value.app.config.maxBodyBytes });
    const c2 = new Client({ name: 'e2e-local-soc-85', version: '0.0.0' });
    await c2.connect(new StreamableHTTPClientTransport(new URL(s2.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }) as unknown as Transport);
    try {
      const plan = PlanSchema.parse((await c2.callTool({ name: 'plan_comfort', arguments: { goal: 'cool' } })).structuredContent);
      expect(plan.lastResort).toBeUndefined();
    } finally {
      await c2.close();
      await s2.close();
    }
    for (const bad of ['abc', '101', '1']) {
      expect(createLocalApp({ ...env, MCP_SCENARIO_START_SOC_PCT: bad }, { wallClock: wall, logger: { log: () => undefined } })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    }
  });
});
