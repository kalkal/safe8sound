import { GetDemoSettingsOutputSchema, PhoneInboxSchema, HOME_HEADER, HomeIdSchema, PlanSchema, SafeRoomStatusSchema, SetScenarioOutputSchema, toolError, type HomeId } from '@cold-reserve/contracts';
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
  it('a visitor plays the storm with no one at risk at home; the other sandbox and demo keep the heatwave; demo lists no settings tools', async () => {
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
    const set = await a.call('set_scenario', { scenarioId: 'storm-blackout', household: 'no-one-at-risk' });
    expect(set.isError).not.toBe(true);
    expect(SetScenarioOutputSchema.parse(set.structuredContent)).toMatchObject({ restarted: true, settings: { version: 2, scenarioId: 'storm-blackout' } });

    // The sandbox's own clock: its plans and safe room fall on the storm day, with an adult (no one at risk) in the safe room.
    expect(await planDay(a.call)).toBe('2026-07-17');
    const room = SafeRoomStatusSchema.parse((await a.call('get_safe_room_status')).structuredContent);
    expect(room.occupantRoles).toContain('adult');
    expect(room.occupantRoles).not.toContain('grandpa');
    expect(GetDemoSettingsOutputSchema.parse((await a.call('get_demo_settings')).structuredContent).settings.household).toBe('no-one-at-risk');

    expect(await planDay(b.call)).toBe('2026-07-16');
    expect(await planDay(demo.call)).toBe('2026-07-16');
    // A new sandbox stores its start at its first request (#449): no "no settings saved" warning for it, and never a home id.
    expect(logger.lines.filter((l) => l.details?.['event'] === 'settings_missing')).toEqual([]);
    expect(JSON.stringify(logger.lines)).not.toContain(A);
  });

  it('a visitor who chooses °F reads the plan in °F at the next call; the other sandbox keeps °C (#306)', async () => {
    const local = createLocalApp(ENV, { wallClock: settableClock(WALL), logger: memoryLogger() });
    if (!local.ok) throw new Error(local.error.message);
    const open = await serve(local.value.app);
    const a = await open(A);
    const b = await open(B);
    const text = async (call: typeof a.call) => ((await call('plan_comfort', { goal: 'cool' }))['content'] as { text: string }[])[0]?.text ?? '';
    expect(await text(a.call)).toMatch(/What it does: [^.]*at \d+(\.\d)? °C/);
    expect((await a.call('set_scenario', { units: 'F' })).isError).not.toBe(true);
    expect(await text(a.call)).toMatch(/What it does: [^.]*at \d+(\.\d)? °F/);
    expect(await text(b.call)).toMatch(/What it does: [^.]*at \d+(\.\d)? °C/);
    // Every tool text of the °F sandbox: no °C left, the guard's reasons included.
    const said = async (name: string, args: Record<string, unknown> = {}) => ((await a.call(name, args))['content'] as { text: string }[])[0]?.text ?? '';
    for (const t of [await text(a.call), await said('get_safe_room_status'), await said('start_storm_mode', { mode: 'prepare' })]) expect(t).not.toContain('°C');
    // Preferences are written in °C: said in °F with the °C to send in brackets.
    expect(await said('get_preferences')).toContain('at most 80.6 °F (27 C)');
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

    // The visitor plays the day again: a new playthrough, without the old storm and its message.
    wall.set(WALL + 60_000);
    expect(SetScenarioOutputSchema.parse((await a.call('set_scenario', { restart: true })).structuredContent).restarted).toBe(true);
    expect(await told()).toBe(0);

    // The new day starts with the grid down: its first read starts the storm on its own and tells the family once
    // (#379); asking for storm mode and more readings tell no one more.
    for (let i = 0; i < 3; i++) expect(await phase()).toBe('active');
    expect(await told()).toBe(1);
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

  it('two containers reading a sandbox inside its outage at once tell the family once (#379)', async () => {
    const table = createFakeTable();
    const container = (seed: number) => {
      const wall = settableClock(WALL);
      const real = dynamoStateStoreFactory({ table, clock: wall, rng: seededRng(seed) });
      // The storm session read answers late, so both containers read "no storm yet" before either writes: the race of #379.
      const slow: typeof real = (home, scope) =>
        new Proxy(real(home, scope), {
          get: (target, key) => {
            const value: unknown = Reflect.get(target, key);
            if (typeof value !== 'function') return value;
            const bound = (value as (...args: unknown[]) => unknown).bind(target);
            if (key !== 'getLatestStormSession') return bound;
            return async () => {
              const read = await bound();
              await new Promise((r) => setTimeout(r, 150));
              return read;
            };
          },
        });
      const app = createLambdaApp({ ...ENV, MCP_SCENARIO_ANCHOR: 'daily' }, { wallClock: wall, logger: memoryLogger(), storeFor: slow });
      if (!app.ok) throw new Error(app.error.message);
      return app.value;
    };
    const one = await (await serve(container(1)))(A);
    const two = await (await serve(container(2)))(A);
    // The storm day at 10:00: the grid has been down since 03:00. The daughter is registered in the app.
    expect((await one.call('set_scenario', { scenarioId: 'storm-blackout' })).isError).not.toBe(true);
    await dynamoStateStoreFactory({ table, clock: settableClock(WALL), rng: seededRng(9) })(HomeIdSchema.parse(A)).putPreferences(preferences, []);
    const started = async () => (await table.query(`HOME#${A}`, '')).filter((i) => i.SK.includes('INBOX#') && JSON.stringify(i).includes('storm_started')).length;
    expect(await started()).toBe(0);

    const reads = await Promise.all([one.call('get_safe_room_status'), two.call('get_safe_room_status'), one.call('get_home_status'), two.call('get_home_status')]);
    expect(reads.every((r) => r.isError !== true)).toBe(true);
    expect(await started()).toBe(1);
    expect((await table.query(`HOME#${A}`, '')).filter((i) => i.SK.includes('STORM#'))).toHaveLength(1);
    await Promise.all([one.call('get_safe_room_status'), two.call('get_safe_room_status')]);
    expect(await started()).toBe(1);
  });

  // #387: two containers on one table, each store wrapped (a late session read, a failing save).
  const stormContainers = async (wrap: (seed: number, name: string, call: () => Promise<unknown>) => Promise<unknown>) => {
    const table = createFakeTable();
    const container = (seed: number) => {
      const wall = settableClock(WALL);
      const real = dynamoStateStoreFactory({ table, clock: wall, rng: seededRng(seed) });
      const wrapped: typeof real = (home, scope) =>
        new Proxy(real(home, scope), {
          get: (target, key) => {
            const value: unknown = Reflect.get(target, key);
            if (typeof value !== 'function') return value;
            const bound = (value as (...args: unknown[]) => unknown).bind(target);
            return (...args: unknown[]) => wrap(seed, String(key), () => Promise.resolve(bound(...args)));
          },
        });
      const app = createLambdaApp({ ...ENV, MCP_SCENARIO_ANCHOR: 'daily' }, { wallClock: wall, logger: memoryLogger(), storeFor: wrapped });
      if (!app.ok) throw new Error(app.error.message);
      return app.value;
    };
    const one = await (await serve(container(1)))(A);
    const two = await (await serve(container(2)))(A);
    // The storm day at 10:00: the grid has been down since 03:00. The daughter is registered in the app.
    expect((await one.call('set_scenario', { scenarioId: 'storm-blackout' })).isError).not.toBe(true);
    await dynamoStateStoreFactory({ table, clock: settableClock(WALL), rng: seededRng(9) })(HomeIdSchema.parse(A)).putPreferences(preferences, []);
    const items = async (kind: string) => (await table.query(`HOME#${A}`, '')).filter((i) => i.SK.includes(kind));
    const started = async () => (await items('INBOX#')).filter((i) => JSON.stringify(i).includes('storm_started')).length;
    const sessionOf = (r: Record<string, unknown>) => (r['structuredContent'] as { session?: { id: string; phase: string } } | undefined)?.session;
    return { one, two, items, started, sessionOf };
  };

  it('a container that stops after claiming the storm start leaves the session open: the next request finds it (#387)', async () => {
    const down = toolError('store_unavailable', 'Down.');
    // Container 1 claims the alert and tells the family, then its session save fails (a DynamoDB error, a timeout).
    const t = await stormContainers((seed, name, call) => (seed === 1 && name === 'saveStormSession' ? Promise.resolve({ ok: false, error: down }) : call()));
    expect((await t.one.call('get_home_status')).isError).not.toBe(true);
    expect(await t.started()).toBe(1);
    expect(await t.items('STORM#')).toHaveLength(1);
    // The other container's storm request finds the storm open: no "left no open session", no second alert.
    const asked = await t.two.call('start_storm_mode', { mode: 'active' });
    expect(asked.isError).not.toBe(true);
    expect(t.sessionOf(asked)?.phase).toBe('active');
    expect(await t.started()).toBe(1);
    expect(await t.items('STORM#')).toHaveLength(1);
  });

  it('two containers asking for the storm at once both get the one session, and the family is told once (#387)', async () => {
    // Both read "no storm yet" before either writes: both detect the storm start at once.
    const t = await stormContainers(async (_seed, name, call) => {
      const out = await call();
      if (name === 'getLatestStormSession') await new Promise((r) => setTimeout(r, 150));
      return out;
    });
    const both = await Promise.all([t.one.call('start_storm_mode', { mode: 'active' }), t.two.call('start_storm_mode', { mode: 'active' })]);
    expect(both.map((r) => r.isError === true)).toEqual([false, false]);
    const ids = both.map((r) => t.sessionOf(r)?.id);
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBe(ids[0]);
    expect(await t.items('STORM#')).toHaveLength(1);
    expect(await t.started()).toBe(1);
  });

  it('°F chosen through one container is said by the other: the plan, the preferences and an unconverted number (#306, #324)', async () => {
    const table = createFakeTable();
    const container = (seed: number) => {
      const wall = settableClock(WALL);
      const app = createLambdaApp({ ...ENV, MCP_SCENARIO_ANCHOR: 'daily' }, { wallClock: wall, logger: memoryLogger(), storeFor: dynamoStateStoreFactory({ table, clock: wall, rng: seededRng(seed) }) });
      if (!app.ok) throw new Error(app.error.message);
      return app.value;
    };
    const one = await (await serve(container(1)))(A);
    const two = await (await serve(container(2)))(A);
    const said = async (name: string, args: Record<string, unknown> = {}) => ((await two.call(name, args))['content'] as { text: string }[])[0]?.text ?? '';
    expect((await one.call('set_scenario', { units: 'F' })).isError).not.toBe(true);
    expect(await said('plan_comfort', { goal: 'cool' })).toMatch(/What it does: [^.]*at \d+(\.\d)? °F/);
    expect(await said('get_preferences')).toContain('at most 80.6 °F (27 C)');
    // The Lambda entry's preferences know the sandbox's unit too: 68 is a °F number sent as °C.
    expect(await said('set_preferences', { comfortC: { heating: 68 }, confirmed: true })).toContain('68 °F is 20 °C: send comfortC.heating 20.');
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

describe('the family contact of a sandbox (#267)', () => {
  it('a visitor sandbox starts with Ana, the daughter: the storm start reaches her, notify_family too (sent 1), the model sees the role only', async () => {
    const local = createLocalApp({ ...ENV, MCP_SCENARIO: 'storm-blackout' }, { wallClock: settableClock(WALL), logger: memoryLogger() });
    if (!local.ok) throw new Error(local.error.message);
    const a = await (await serve(local.value.app))(A);
    expect((await a.call('start_storm_mode', { mode: 'prepare' })).isError).not.toBe(true);
    // The storm flow tells her by itself when the storm starts.
    const started = await local.value.stormMode.inbox(HomeIdSchema.parse(A));
    expect(started.ok && started.value.map((m) => [m.role, m.transition])).toContainEqual(['daughter', 'storm_started']);
    expect(started.ok && started.value[0]?.text).toContain('Ana');
    // And notify_family reaches her for another transition, the model seeing her role only.
    const sent = await a.call('notify_family', { transition: 'essential_level' });
    expect(sent.isError).not.toBe(true);
    expect(sent.structuredContent).toMatchObject({ sent: [{ role: 'daughter', channel: 'in_app' }] });
    expect(JSON.stringify(sent)).not.toContain('Ana');
    const inbox = await local.value.stormMode.inbox(HomeIdSchema.parse(A));
    expect(inbox.ok && inbox.value.map((m) => m.transition)).toEqual(['essential_level', 'storm_started']);
  });
});

describe('the sandbox family phone on the Lambda entry (#267, approved in #267)', () => {
  it("a storm in a sandbox reaches Ana; another container's /phone/inbox, with sim-api's sandbox phone token, shows it", async () => {
    const PHONE = 'f'.repeat(32);
    const table = createFakeTable();
    const container = (seed: number) => {
      const wall = settableClock(WALL);
      const app = createLambdaApp(
        { ...ENV, MCP_CLIENTS: `${ENV.MCP_CLIENTS},phone:daughter@demo#*=${PHONE}`, MCP_SCENARIO_ANCHOR: 'daily' },
        { wallClock: wall, logger: memoryLogger(), storeFor: dynamoStateStoreFactory({ table, clock: wall, rng: seededRng(seed) }) },
      );
      if (!app.ok) throw new Error(app.error.message);
      return app.value;
    };
    const one = await (await serve(container(1)))(A);
    expect((await one.call('set_scenario', { scenarioId: 'storm-blackout' })).isError).not.toBe(true);
    expect((await one.call('start_storm_mode', { mode: 'prepare' })).isError).not.toBe(true);

    const two = container(2);
    const server = await startNodeServer(two.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: two.config.maxBodyBytes });
    cleanup.push(() => server.close());
    const inboxUrl = new URL('/phone/inbox', server.url);
    const res = await fetch(inboxUrl, { headers: { authorization: `Bearer ${PHONE}`, 'x-cold-reserve-home': A } });
    expect(res.status).toBe(200);
    const inbox = PhoneInboxSchema.parse(await res.json());
    expect(inbox.messages.map((m) => [m.role, m.transition])).toContainEqual(['daughter', 'storm_started']);
    expect(inbox.messages[0]?.text).toContain('Ana');
    // The agent's token never opens the phone.
    expect((await fetch(inboxUrl, { headers: { authorization: `Bearer ${TOKEN}`, 'x-cold-reserve-home': A } })).status).toBe(401);
  });
});
