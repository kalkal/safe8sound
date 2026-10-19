import { GetMilestonesOutputSchema, HOME_HEADER } from '@cold-reserve/contracts';
import { memoryLogger } from '@cold-reserve/core';
import { createMemoryBacking } from '@cold-reserve/store-memory';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApp } from '../../src/local-app.js';
import { startNodeServer } from '../../src/node-server.js';
import { settableClock } from '../comfort-plan/support.js';
import { TOKEN } from '../helpers.js';

// #449 (the judge's journey, 18 Oct): every judge sees the same story from its start. A NEW sandbox plays the scenario's
// day from its beginning, whatever the wall-clock hour they open the site: the start a "Restart the day" gives. Before,
// with the daily anchor as deployed (infra/cdk.json), a fresh sandbox played the reference place's hour now (09:00 for a
// judge at 09:00 in Rome, 21:00 at 21:00), and with the `start` anchor the hours since the Lambda container started.
// Every container plays the same start: the first one stores it with the sandbox's settings, the others adopt it.

const H = 3_600_000;
/** 18 Oct 2026, 09:00 and 21:00 in Rome (CEST, UTC+2). */
const MORNING = Date.parse('2026-10-18T07:00:00Z');
const EVENING = Date.parse('2026-10-18T19:00:00Z');
const CLIENTS = { MCP_CLIENTS: `agent@demo#*=${TOKEN}`, MCP_SCENARIO: 'clear-day' };
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** One server (a Lambda container), on its own wall clock; `backing`: the store it shares with other containers. */
async function server(env: Record<string, string>, wallMs: number, backing = createMemoryBacking()) {
  const wall = settableClock(wallMs);
  const local = createLocalApp({ ...CLIENTS, ...env }, { wallClock: wall, logger: memoryLogger(), backing });
  if (!local.ok) throw new Error(local.error.message);
  const { app } = local.value;
  const node = await startNodeServer(app.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: app.config.maxBodyBytes });
  cleanup.push(() => node.close());
  /** A visitor session on this container: the sandbox of `home`, as each demo code exchange is (#101). */
  const visitor = async (home: string) => {
    const client = new Client({ name: `e2e-${home}`, version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(node.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, [HOME_HEADER]: home } } }) as unknown as Transport);
    cleanup.push(() => client.close());
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    /** The sandbox's local time now, "HH:MM", as the clock bar shows it. */
    const time = async () => /T(\d{2}:\d{2})/.exec(GetMilestonesOutputSchema.parse((await call('get_milestones')).structuredContent).now)?.[1];
    /** The start "Restart the day" gives the same scenario. */
    const restarted = async () => {
      expect((await call('set_scenario', { restart: true })).isError).not.toBe(true);
      return time();
    };
    return { call, time, restarted };
  };
  return { wall, visitor };
}

describe("a judge's fresh session starts the day at its beginning, whatever the hour (#449)", () => {
  it('daily anchor, as deployed: fresh sandboxes at 09:00 and at 21:00 both show the day start a restart gives', async () => {
    const seen: string[] = [];
    for (const [wallMs, home] of [
      [MORNING, 'demo#00000000000000a1'],
      [EVENING, 'demo#00000000000000a2'],
    ] as const) {
      const { visitor } = await server({ MCP_SCENARIO_ANCHOR: 'daily' }, wallMs);
      const judge = await visitor(home);
      const fresh = (await judge.time()) ?? '';
      expect(fresh).toBe(await judge.restarted());
      seen.push(fresh);
    }
    expect(seen[0]).toBe(seen[1]);
    // The owner's choice B (19 Oct): the clear day plays from 12:00, as the storm day starts.
    expect(seen[0]).toBe('12:00');
  });

  it('start anchor: a judge nine hours after the container started still starts at the day start', async () => {
    const { wall, visitor } = await server({}, MORNING);
    const first = await visitor('demo#00000000000000b1');
    const start = await first.time();
    wall.set(MORNING + 9 * H);
    const second = await visitor('demo#00000000000000b2');
    expect(await second.time()).toBe(start);
    expect(await second.time()).toBe(await second.restarted());
  });

  it('an explicit MCP_SCENARIO_START_H is the hour a sandbox plays from, a new one and a restart alike, never added to the scenario hour', async () => {
    const { visitor } = await server({ MCP_SCENARIO_ANCHOR: 'daily', MCP_SCENARIO_START_H: '3' }, MORNING);
    const judge = await visitor('demo#00000000000000d1');
    expect(await judge.time()).toBe('03:00');
    expect(await judge.restarted()).toBe('03:00');
  });

  it('two containers sharing the store play one start for the same sandbox, the one stored first', async () => {
    const backing = createMemoryBacking();
    const a = await server({ MCP_SCENARIO_ANCHOR: 'daily' }, MORNING, backing);
    const judgeOnA = await a.visitor('demo#00000000000000c1');
    const start = await judgeOnA.time();
    // Three real hours later the same judge's next request lands on a container that never saw this sandbox.
    const b = await server({ MCP_SCENARIO_ANCHOR: 'daily' }, MORNING + 3 * H, backing);
    a.wall.set(MORNING + 3 * H);
    const judgeOnB = await b.visitor('demo#00000000000000c1');
    expect(await judgeOnB.time()).toBe(await judgeOnA.time());
    expect(await judgeOnA.time()).not.toBe(start);
  });
});
