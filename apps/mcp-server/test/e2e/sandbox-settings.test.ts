import { GetDemoSettingsOutputSchema, HOME_HEADER, HomeIdSchema, PlanSchema, SafeRoomStatusSchema, SetScenarioOutputSchema, toolError, type HomeId } from '@cold-reserve/contracts';
import { memoryLogger, seededRng, type StateStore } from '@cold-reserve/core';
import { dynamoStateStoreFactory } from '@cold-reserve/store-dynamodb';
import { createFakeTable } from '@cold-reserve/store-dynamodb/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { createLambdaApp } from '../../src/lambda-app.js';
import { createLocalApp } from '../../src/local-app.js';
import { startNodeServer } from '../../src/node-server.js';
import { settableClock } from '../comfort-plan/support.js';
import { TOKEN } from '../helpers.js';
import { preferences } from '../storm-mode/support.js';

// C2b (#222): a visitor's choices for their own sandbox, saved in the store, played by every container at its next
// request, on the sandbox's own scenario clock. The env plays the heatwave (16 July); a sandbox may choose the
// storm (17 July) and who is at home. The real home and `demo` never list the tools.

const WALL = Date.parse('2026-10-04T10:00:00Z');
const A = 'demo#00000000000000aa';
const B = 'demo#00000000000000bb';
const ENV = { MCP_CLIENTS: `agent@demo#*=${TOKEN}`, MCP_SCENARIO: 'heatwave', MCP_SCENARIO_START_H: '10' };
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function serve(app: App) {
  const server = await startNodeServer(app.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: app.config.maxBodyBytes });
  cleanup.push(() => server.close());
  return async (home: string) => {
    const client = new Client({ name: `e2e-${home}`, version: '0.0.0' });
    const headers = { authorization: `Bearer ${TOKEN}`, ...(home === 'demo' ? {} : { [HOME_HEADER]: home }) };
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }) as unknown as Transport);
    cleanup.push(() => client.close());
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const tools = async () => (await client.listTools()).tools.map((t) => t.name);
    return { call, tools };
  };
}

const planDay = async (call: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>) =>
  PlanSchema.parse((await call('plan_comfort', { goal: 'cool' }))['structuredContent']).createdAt.slice(0, 10);

describe('sandbox settings on the local entry', () => {
  it('a visitor plays the storm with grandma at home; the other sandbox and demo keep the heatwave; demo lists no settings tools', async () => {
    const logger = memoryLogger();
    const local = createLocalApp(ENV, { wallClock: settableClock(WALL), logger });
    if (!local.ok) throw new Error(local.error.message);
    const open = await serve(local.value.app);
    const a = await open(A);
    const b = await open(B);
    const demo = await open('demo');

    expect(await a.tools()).toEqual(expect.arrayContaining(['get_demo_settings', 'set_scenario']));
    expect(await demo.tools()).not.toContain('set_scenario');
    expect(await demo.tools()).not.toContain('get_demo_settings');

    expect(await planDay(a.call)).toBe('2026-07-16');
    const set = await a.call('set_scenario', { scenarioId: 'storm-blackout', household: 'older-woman' });
    expect(set.isError).not.toBe(true);
    expect(SetScenarioOutputSchema.parse(set.structuredContent)).toMatchObject({ restarted: true, settings: { version: 1, scenarioId: 'storm-blackout' } });

    // The sandbox's own clock: its plans and safe room fall on the storm day, with grandma in the safe room.
    expect(await planDay(a.call)).toBe('2026-07-17');
    const room = SafeRoomStatusSchema.parse((await a.call('get_safe_room_status')).structuredContent);
    expect(room.occupantRoles).toContain('grandma');
    expect(room.occupantRoles).not.toContain('grandpa');
    expect(GetDemoSettingsOutputSchema.parse((await a.call('get_demo_settings')).structuredContent).settings.household).toBe('older-woman');

    expect(await planDay(b.call)).toBe('2026-07-16');
    expect(await planDay(demo.call)).toBe('2026-07-16');
    // One warning per sandbox built from the defaults (B and A before its first change), never a home id.
    expect(logger.lines.filter((l) => l.level === 'warn' && l.details?.['event'] === 'settings_missing').length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(logger.lines)).not.toContain(A);
  });

  it('a restart plays the day again from its start hour', async () => {
    const wall = settableClock(WALL);
    const local = createLocalApp(ENV, { wallClock: wall, logger: memoryLogger() });
    if (!local.ok) throw new Error(local.error.message);
    const a = await (await serve(local.value.app))(A);
    await a.call('set_scenario', { units: 'F' });
    wall.set(WALL + 3 * 3_600_000);
    const late = PlanSchema.parse((await a.call('plan_comfort', { goal: 'cool' })).structuredContent);
    expect(new Date(late.createdAt).toISOString()).toBe('2026-07-16T11:00:00.000Z');
    await a.call('set_scenario', { restart: true });
    const again = PlanSchema.parse((await a.call('plan_comfort', { goal: 'cool' })).structuredContent);
    // Start hour 10 on 16 July in Rome (08:00 UTC), three wall hours before vs now.
    expect(Date.parse(late.createdAt) - Date.parse(again.createdAt)).toBe(3 * 3_600_000);
    expect(new Date(again.createdAt).toISOString()).toBe('2026-07-16T08:00:00.000Z');
  });
});

describe('a sandbox in Houston (L2, #247)', () => {
  it('replays the storm in Houston: its real July day, its plans and safe hours in Chicago time, its place in the settings', async () => {
    const local = createLocalApp(ENV, { wallClock: settableClock(WALL), logger: memoryLogger() });
    if (!local.ok) throw new Error(local.error.message);
    const a = await (await serve(local.value.app))(A);
    const set = await a.call('set_scenario', { scenarioId: 'storm-blackout', locationId: 'houston' });
    expect(set.isError).not.toBe(true);
    expect(SetScenarioOutputSchema.parse(set.structuredContent)).toMatchObject({ restarted: true, settings: { locationId: 'houston' } });

    const settings = GetDemoSettingsOutputSchema.parse((await a.call('get_demo_settings')).structuredContent);
    expect(settings.place).toMatchObject({ id: 'houston', label: 'Houston, Texas', tz: 'America/Chicago' });
    // Start hour 12 + 10 on the storm day of 7 July 2024: 22:00 in Houston.
    const plan = PlanSchema.parse((await a.call('plan_comfort', { goal: 'cool' })).structuredContent);
    expect(plan.horizonAt).toMatch(/^2024-07-0[78]T.*-05:00$/);
    const room = SafeRoomStatusSchema.parse((await a.call('get_safe_room_status')).structuredContent);
    expect(room.safeUntil).toMatch(/-05:00$/);
  });
});

describe('replaying the storm in a sandbox (#239 review, #234)', () => {
  it('storm, restart, storm again: the old storm is gone and the family is told exactly once per storm', async () => {
    const wall = settableClock(WALL);
    const local = createLocalApp(ENV, { wallClock: wall, logger: memoryLogger() });
    if (!local.ok) throw new Error(local.error.message);
    const a = await (await serve(local.value.app))(A);
    const home = HomeIdSchema.parse(A);
    const told = async () => {
      const listed = await local.value.stormMode.inbox(home);
      if (!listed.ok) throw new Error(listed.error.message);
      return listed.value.filter((m) => m.transition === 'storm_started').length;
    };
    const phase = async () => SafeRoomStatusSchema.parse((await a.call('get_safe_room_status')).structuredContent).stormPhase;

    // The storm day at 22:00 (start hour 12 + 10): the grid is down. The daughter is registered in the app.
    expect((await a.call('set_scenario', { scenarioId: 'storm-blackout' })).isError).not.toBe(true);
    expect((await local.value.stormMode.storeFor(home).putPreferences(preferences, [])).ok).toBe(true);
    expect((await a.call('start_storm_mode', { mode: 'prepare' })).isError).not.toBe(true);
    for (let i = 0; i < 3; i++) expect(await phase()).toBe('active');
    expect(await told()).toBe(1);

    // The visitor plays the day again: a new playthrough, without the old storm and without telling anyone.
    wall.set(WALL + 60_000);
    expect(SetScenarioOutputSchema.parse((await a.call('set_scenario', { restart: true })).structuredContent).restarted).toBe(true);
    for (let i = 0; i < 3; i++) expect(await phase()).toBeUndefined();
    expect(await told()).toBe(0);

    // The storm again: told once, and the readings tell no one more.
    expect((await a.call('start_storm_mode', { mode: 'prepare' })).isError).not.toBe(true);
    for (let i = 0; i < 3; i++) expect(await phase()).toBe('active');
    expect(await told()).toBe(1);
  });
});

describe('sandbox settings on the Lambda entry: two containers, one table', () => {
  it('a change made through one container is played by the other at its next request', async () => {
    const table = createFakeTable();
    const container = (seed: number) => {
      const wall = settableClock(WALL);
      const app = createLambdaApp({ ...ENV, MCP_SCENARIO_ANCHOR: 'daily' }, { wallClock: wall, logger: memoryLogger(), storeFor: dynamoStateStoreFactory({ table, clock: wall, rng: seededRng(seed) }) });
      if (!app.ok) throw new Error(app.error.message);
      return app.value;
    };
    const one = await (await serve(container(1)))(A);
    const two = await (await serve(container(2)))(A);
    expect(await planDay(two.call)).toBe('2026-07-16');
    expect((await one.call('set_scenario', { scenarioId: 'storm-blackout' })).isError).not.toBe(true);
    expect(await planDay(two.call)).toBe('2026-07-17');
    expect(GetDemoSettingsOutputSchema.parse((await two.call('get_demo_settings')).structuredContent).settings.scenarioId).toBe('storm-blackout');
  });

  it('a store that cannot read the settings leaves the sandbox playing what it played, and says so in the log', async () => {
    const table = createFakeTable();
    const wall = settableClock(WALL);
    const logger = memoryLogger();
    const real = dynamoStateStoreFactory({ table, clock: wall, rng: seededRng(3) });
    let down = false;
    const storeFor = (home: HomeId, scope?: { correlationId?: string }): StateStore => {
      const store = real(home, scope);
      if (!down) return store;
      const failed = () => Promise.resolve({ ok: false as const, error: toolError('store_unavailable', 'Down.') });
      return new Proxy(store, {
        get: (target, key) => {
          if (key === 'getSandboxSettings') return failed;
          const value: unknown = Reflect.get(target, key);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    };
    const app = createLambdaApp({ ...ENV, MCP_SCENARIO_ANCHOR: 'daily' }, { wallClock: wall, logger, storeFor });
    if (!app.ok) throw new Error(app.error.message);
    const a = await (await serve(app.value))(A);
    await a.call('set_scenario', { scenarioId: 'storm-blackout' });
    down = true;
    expect(await planDay(a.call)).toBe('2026-07-17');
    expect(logger.lines.some((l) => l.level === 'warn' && l.code === 'store_unavailable' && l.details?.['event'] === 'settings_read_failed')).toBe(true);
  });
});
