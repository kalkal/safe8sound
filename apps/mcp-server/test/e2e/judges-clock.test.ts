import { AdvanceClockOutputSchema, GetMilestonesOutputSchema, HOME_HEADER, HomeIdSchema, PlanSchema, type GetMilestonesOutput } from '@cold-reserve/contracts';
import { memoryLogger } from '@cold-reserve/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApp } from '../../src/local-app.js';
import { startNodeServer } from '../../src/node-server.js';
import { settableClock } from '../comfort-plan/support.js';
import { HOME_TOKEN, TOKEN } from '../helpers.js';

// #311 (approved in #311): the judges' clock end to end, on the local entry. A visitor's storm day starts at
// midnight; the grid goes down 3 hours later and comes back at 18:30. Jumping ahead runs the storm detector on the
// way, so the family phone gets each message exactly once; a restart is the only way back, to a fresh playthrough.

const WALL = Date.parse('2026-10-10T10:00:00Z');
const A = 'demo#00000000000000aa';
const ENV = { MCP_CLIENTS: `agent@demo#*=${TOKEN},video@home=${HOME_TOKEN}`, MCP_SCENARIO: 'storm-blackout' };
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function open(extra: Record<string, string> = {}) {
  const logger = memoryLogger();
  const wall = settableClock(WALL);
  const local = createLocalApp({ ...ENV, ...extra }, { wallClock: wall, logger });
  if (!local.ok) throw new Error(local.error.message);
  const { app, stormMode } = local.value;
  const server = await startNodeServer(app.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: app.config.maxBodyBytes });
  cleanup.push(() => server.close());
  const connect = async (home: string, token = TOKEN) => {
    const client = new Client({ name: `e2e-${home}`, version: '0.0.0' });
    const headers = { authorization: `Bearer ${token}`, ...(home === 'demo' || home === 'home' ? {} : { [HOME_HEADER]: home }) };
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }) as unknown as Transport);
    cleanup.push(() => client.close());
    return {
      call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }),
      tools: async () => (await client.listTools()).tools.map((t) => t.name),
    };
  };
  const told = async () => {
    const inbox = await stormMode.inbox(HomeIdSchema.parse(A));
    if (!inbox.ok) throw new Error(inbox.error.message);
    return inbox.value.map((m) => m.transition).sort();
  };
  /** The phone's list as it shows it: newest first, each message at its time on the scenario clock. */
  const phone = async () => {
    const inbox = await stormMode.inbox(HomeIdSchema.parse(A));
    if (!inbox.ok) throw new Error(inbox.error.message);
    return inbox.value.map((m) => [m.transition, m.at] as const);
  };
  return { connect, told, phone, logger, wall };
}

const milestones = async (a: { call: (n: string, x?: Record<string, unknown>) => Promise<Record<string, unknown>> }, args: Record<string, unknown> = {}): Promise<GetMilestonesOutput> =>
  GetMilestonesOutputSchema.parse((await a.call('get_milestones', args))['structuredContent']);

const find = (list: GetMilestonesOutput, kind: string) => {
  const m = list.milestones.find((x) => x.kind === kind);
  if (m === undefined) throw new Error(`no ${kind} in ${JSON.stringify(list)}`);
  return m;
};

describe('the judges clock on the local entry (#311)', () => {
  it('lists the storm and power back ahead; jumping past the storm start tells the family exactly once', async () => {
    const { connect, told, logger } = await open();
    const a = await connect(A);
    const list = await milestones(a);
    expect(list.milestones.map((m) => m.kind)).toEqual(expect.arrayContaining(['storm_start', 'power_back']));
    const storm = find(list, 'storm_start');

    const jumped = await a.call('advance_clock', { kind: storm.kind, at: storm.at });
    expect(jumped.isError).not.toBe(true);
    expect(AdvanceClockOutputSchema.parse(jumped.structuredContent).now).toBe(storm.at);
    expect(await told()).toEqual(['storm_started']);

    // More jumps and reads inside the storm tell no one more.
    expect((await a.call('advance_clock', { hours: 1 })).isError).not.toBe(true);
    expect((await a.call('get_safe_room_status')).isError).not.toBe(true);
    expect(await told()).toEqual(['storm_started']);
    // The storm already started is behind now: it is no longer listed, and cannot be chosen again.
    expect((await milestones(a)).milestones.map((m) => m.kind)).not.toContain('storm_start');
    expect((await a.call('advance_clock', { kind: storm.kind, at: storm.at })).isError).toBe(true);

    expect(logger.lines.filter((l) => l.details?.['event'] === 'clock_advanced')).toHaveLength(2);
    expect(JSON.stringify(logger.lines)).not.toContain(A);
  });

  it('a double tap on the storm start: one jump, one conflict, the family told exactly once', async () => {
    const { connect, told } = await open();
    const a = await connect(A);
    const storm = find(await milestones(a), 'storm_start');
    const both = await Promise.all([a.call('advance_clock', { kind: storm.kind, at: storm.at }), a.call('advance_clock', { kind: storm.kind, at: storm.at })]);
    expect(both.filter((r) => r.isError !== true)).toHaveLength(1);
    // Interleaved, the second is a version conflict (the unit test); served after the first, its moment is behind now.
    const refused = both.filter((r) => r.isError === true).map((r) => (r.structuredContent as { code?: string }).code);
    expect(refused).toHaveLength(1);
    expect(['settings_version_conflict', 'invalid_input']).toContain(refused[0]);
    expect((await milestones(a)).now).toBe(storm.at);
    expect(await told()).toEqual(['storm_started']);
  });

  it('a plan made in the storm on a low battery is essential: the family hears it once, at the next jump; power back once, at its moment', async () => {
    const { connect, told, phone } = await open({ MCP_SCENARIO_START_SOC_PCT: '40' });
    const a = await connect(A);
    const storm = find(await milestones(a), 'storm_start');
    await a.call('advance_clock', { kind: storm.kind, at: storm.at });
    const plan = PlanSchema.parse((await a.call('plan_comfort', { goal: 'cool' })).structuredContent);
    expect(plan.steps.some((s) => s.level === 'essential')).toBe(true);
    expect(await told()).toEqual(['storm_started']);
    expect((await a.call('advance_clock', { hours: 1, planId: plan.id })).isError).not.toBe(true);
    expect((await a.call('advance_clock', { hours: 1, planId: plan.id })).isError).not.toBe(true);
    expect(await told()).toEqual(['essential_level', 'storm_started']);

    // Power back is listed when the grid has been stable: jumping to it shows the family message right then, once.
    const back = find(await milestones(a), 'power_back');
    expect((await a.call('advance_clock', { kind: back.kind, at: back.at })).isError).not.toBe(true);
    expect(await told()).toEqual(['essential_level', 'power_back', 'storm_started']);
    // The phone lists them newest first, each at its scenario time (the wall clock never moved here): the storm at its
    // start, the essential level at the first jump's first stop, an hour later, power back at its listed moment.
    const hour = 3_600_000;
    expect((await phone()).map(([t, at]) => [t, Date.parse(at)])).toEqual([
      ['power_back', Date.parse(back.at)],
      ['essential_level', Date.parse(storm.at) + hour],
      ['storm_started', Date.parse(storm.at)],
    ]);
    expect((await a.call('advance_clock', { hours: 1 })).isError).not.toBe(true);
    expect(await told()).toEqual(['essential_level', 'power_back', 'storm_started']);
  });

  it('never past the end of the day; a restart is the only way back, to a new playthrough with a quiet phone', async () => {
    const { connect, told, wall } = await open();
    const a = await connect(A);
    const storm = find(await milestones(a), 'storm_start');
    await a.call('advance_clock', { kind: storm.kind, at: storm.at });
    expect((await a.call('advance_clock', { hours: 24 })).isError).toBe(true);
    expect(await told()).toEqual(['storm_started']);
    // The visitor restarts a minute later (wall time).
    wall.set(WALL + 60_000);
    expect((await a.call('set_scenario', { restart: true })).isError).not.toBe(true);
    const again = await milestones(a);
    expect(again.now).toBe(again.day.from);
    expect(find(again, 'storm_start').at).toBe(storm.at);
    expect(await told()).toEqual([]);
  });

  it('a sandbox left alone reaches its storm on its own clock: the next read tells the family once, power back once (#379)', async () => {
    const { connect, told, phone, logger, wall } = await open();
    const a = await connect(A);
    const list = await milestones(a);
    const storm = find(list, 'storm_start');
    const back = find(list, 'power_back');
    // No jump: the wall clock moves and the sandbox's day with it (speed 1), a minute past the grid going down.
    const toWall = (atIso: string) => WALL + Date.parse(atIso) - Date.parse(list.now);
    wall.set(toWall(storm.at) + 60_000);
    expect(await told()).toEqual([]);

    expect((await a.call('get_safe_room_status')).isError).not.toBe(true);
    expect(await told()).toEqual(['storm_started']);
    // More reads inside the storm tell no one more.
    expect((await a.call('get_home_status')).isError).not.toBe(true);
    wall.set(toWall(storm.at) + 2 * 3_600_000);
    expect((await a.call('get_safe_room_status')).isError).not.toBe(true);
    expect(await told()).toEqual(['storm_started']);

    // Past power back with the grid stable: the next read tells the family, once.
    wall.set(toWall(back.at) + 60_000);
    expect((await a.call('get_home_status')).isError).not.toBe(true);
    expect(await told()).toEqual(['power_back', 'storm_started']);
    expect((await a.call('get_home_status')).isError).not.toBe(true);
    expect(await told()).toEqual(['power_back', 'storm_started']);
    expect((await phone()).map(([t]) => t)).toEqual(['power_back', 'storm_started']);

    const caught = logger.lines.filter((l) => l.details?.['event'] === 'storm_caught_up');
    expect(caught.map((l) => l.details?.['transition'])).toEqual(['storm_started', 'power_back']);
    for (const line of caught) {
      expect(line.correlationId).toEqual(expect.any(String));
      expect(line.details?.['home']).toBe('sandbox');
    }
    expect(JSON.stringify(logger.lines)).not.toContain(A);
  });

  it('the real home and demo have no such tools', async () => {
    const { connect } = await open();
    for (const home of ['demo', 'home']) {
      const c = await connect(home, home === 'home' ? HOME_TOKEN : TOKEN);
      const tools = await c.tools();
      expect(tools).not.toContain('get_milestones');
      expect(tools).not.toContain('advance_clock');
      // Not listed, so not even callable: the server knows no such tool for this home.
      await expect(c.call('advance_clock', { hours: 1 })).rejects.toThrow(/Unknown tool/);
    }
  });
});
