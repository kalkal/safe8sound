import { PlanSchema } from '@cold-reserve/contracts';
import { memoryLogger } from '@cold-reserve/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { createLocalApp, wallStamped } from '../../src/local-app.js';
import { startNodeServer } from '../../src/node-server.js';
import { settableClock } from '../comfort-plan/support.js';
import { TOKEN } from '../helpers.js';

// CE-20: the local server's domain runs on the scenario clock (#173), but its log lines line up with the
// sim-api's and the agent's: `ts` is the wall clock, and the scenario time, when it differs, is in the details.

const WALL = Date.parse('2026-10-03T10:00:00Z');

describe('local entry: log lines on the wall clock', () => {
  it('a last-resort plan made in July scenario time is logged at the October wall time, with the scenario time beside it', async () => {
    const wall = settableClock(WALL);
    const logger = memoryLogger();
    const env = { MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_SCENARIO: 'storm-blackout', MCP_SCENARIO_START_H: '8', MCP_SCENARIO_START_SOC_PCT: '30' };
    const local = createLocalApp(env, { wallClock: wall, logger });
    if (!local.ok) throw new Error(local.error.message);
    const server = await startNodeServer(local.value.app.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: local.value.app.config.maxBodyBytes });
    const client = new Client({ name: 'e2e-log-clock', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }) as unknown as Transport);
    try {
      const plan = PlanSchema.parse((await client.callTool({ name: 'plan_comfort', arguments: { goal: 'cool' } })).structuredContent);
      expect(plan.createdAt.startsWith('2026-07-')).toBe(true);
      const proposed = logger.lines.find((l) => l.details?.['event'] === 'last_resort_proposed');
      expect(proposed?.ts).toBe(new Date(WALL).toISOString());
      expect(String(proposed?.details?.['scenarioTs'])).toMatch(/^2026-07-/);
      expect(logger.lines.every((l) => l.ts.startsWith('2026-10-03'))).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('a line already on the wall clock gets no scenario time; a failing sink never breaks the caller', () => {
    const logger = memoryLogger();
    const stamped = wallStamped(logger, { now: () => WALL });
    stamped.log({ ts: new Date(WALL).toISOString(), level: 'info', component: 'mcp-server', message: 'm', correlationId: 'c' });
    expect(logger.lines[0]).toEqual({ ts: new Date(WALL).toISOString(), level: 'info', component: 'mcp-server', message: 'm', correlationId: 'c' });
    const throwing = wallStamped({ log: () => { throw new Error('sink'); } }, { now: () => WALL });
    expect(() => {
      throwing.log({ ts: '2026-07-17T20:00:00.000Z', level: 'info', component: 'mcp-server', message: 'm', correlationId: 'c' });
    }).not.toThrow();
  });
});
