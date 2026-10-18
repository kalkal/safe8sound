import { GetMilestonesOutputSchema, HOME_HEADER } from '@cold-reserve/contracts';
import { memoryLogger } from '@cold-reserve/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApp } from '../../src/local-app.js';
import { startNodeServer } from '../../src/node-server.js';
import { settableClock } from '../comfort-plan/support.js';
import { TOKEN } from '../helpers.js';

// The judge's journey (owner, 18 Oct): what a judge sees on a FRESH session depends on the wall-clock hour they open
// the site. Deployed as infra/cdk.json says (the clear day, the daily anchor, real speed), a fresh sandbox plays the
// clear day at the reference place's hour now: 09:00 for a judge at 09:00 in Rome, 21:00 for one at 21:00. The `start`
// anchor is no better: a fresh sandbox plays the hours since the server (a Lambda container) started. Only a new
// scenario, a new place or "Restart the day" starts the day at its beginning, the storm day at 12:00, for everyone.

const H = 3_600_000;
/** 18 Oct 2026, 09:00 and 21:00 in Rome (CEST, UTC+2). */
const MORNING = Date.parse('2026-10-18T07:00:00Z');
const EVENING = Date.parse('2026-10-18T19:00:00Z');
const CLIENTS = { MCP_CLIENTS: `agent@demo#*=${TOKEN}`, MCP_SCENARIO: 'clear-day' };
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function server(env: Record<string, string>, wallMs: number) {
  const wall = settableClock(wallMs);
  const local = createLocalApp({ ...CLIENTS, ...env }, { wallClock: wall, logger: memoryLogger() });
  if (!local.ok) throw new Error(local.error.message);
  const { app } = local.value;
  const node = await startNodeServer(app.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: app.config.maxBodyBytes });
  cleanup.push(() => node.close());
  /** A new visitor session: its own sandbox, as each demo code exchange is (#101). */
  const visitor = async (home: string) => {
    const client = new Client({ name: `e2e-${home}`, version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(node.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, [HOME_HEADER]: home } } }) as unknown as Transport);
    cleanup.push(() => client.close());
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    /** The sandbox's local time now, "HH:MM", as the clock bar shows it. */
    const time = async () => /T(\d{2}:\d{2})/.exec(GetMilestonesOutputSchema.parse((await call('get_milestones')).structuredContent).now)?.[1];
    return { call, time };
  };
  return { wall, visitor };
}

describe("a judge's fresh session and the wall-clock hour (owner, 18 Oct)", () => {
  it('daily anchor, as deployed: a fresh session plays the hour of the day in Rome; picking the storm starts it at 12:00', async () => {
    for (const [wallMs, hour, home] of [
      [MORNING, '09:00', 'demo#00000000000000a1'],
      [EVENING, '21:00', 'demo#00000000000000a2'],
    ] as const) {
      const { visitor } = await server({ MCP_SCENARIO_ANCHOR: 'daily' }, wallMs);
      const judge = await visitor(home);
      expect(await judge.time()).toBe(hour);
      expect((await judge.call('set_scenario', { scenarioId: 'storm-blackout' })).isError).not.toBe(true);
      expect(await judge.time()).toBe('12:00');
    }
  });

  it('start anchor: a fresh session plays the hours since the server started, so it is no fixed start either', async () => {
    const { wall, visitor } = await server({}, MORNING);
    const first = await visitor('demo#00000000000000b1');
    expect(await first.time()).toBe('00:00');
    // A second judge, nine hours later on the same server (a warm container).
    wall.set(MORNING + 9 * H);
    const second = await visitor('demo#00000000000000b2');
    expect(await second.time()).toBe('09:00');
    expect((await second.call('set_scenario', { scenarioId: 'storm-blackout' })).isError).not.toBe(true);
    expect(await second.time()).toBe('12:00');
  });
});
