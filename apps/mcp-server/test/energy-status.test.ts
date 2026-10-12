import { CARD_TOOL_ACCESS, HomeStatusSchema, ErrorEnvelopeSchema, LogEntrySchema, err, toolError, type HomeStatus } from '@cold-reserve/contracts';
import { fixedClock } from '@cold-reserve/core';
import { describe, expect, it } from 'vitest';
import type { SourceEvent } from '@cold-reserve/source-fallback';
import { createApp, logSourceEvent, type AppOptions } from '../src/app.js';
import type { LogEntry } from '../src/handler.js';
import { homeStatusSummary } from '../src/modules/energy-status/index.js';
import { HOME_TOKEN, TOKEN, callTool, homeId, post, toolResult, toolsList } from './helpers.js';

const WALL = Date.UTC(2026, 8, 29, 7, 0, 0);
const SANDBOX_TOKEN = 's'.repeat(32);
const ENV = { MCP_CLIENTS: `agent@demo=${TOKEN},video@home=${HOME_TOKEN},stranger@nowhere=${'n'.repeat(32)},sandbox@demo#*=${SANDBOX_TOKEN}`, MCP_SCENARIO_START_H: '14' };

function app(env: Record<string, string> = ENV, extra: Partial<AppOptions> = {}) {
  const logs: LogEntry[] = [];
  const result = createApp(env, { wallClock: fixedClock(WALL), logger: { log: (e) => logs.push(e) }, ...extra });
  if (!result.ok) throw new Error(result.error.message);
  return { handler: result.value.handler, logs };
}

describe('get_home_status on the demo home (simulator, clear-day, fixed seed)', () => {
  it('returns a valid status with every data group simulated and the scenario named', async () => {
    const result = await toolResult(await post(app().handler, callTool('get_home_status', {})));
    expect(result.isError).toBeFalsy();
    const status = HomeStatusSchema.parse(result.structuredContent);
    expect(status).toMatchObject({
      homeId: 'demo',
      ts: '2026-07-15T12:00:00.000Z', // 14:00 local (+02:00) on the scenario day
      level: 'comfort',
      levelReason: 'user_choice',
      controlAvailability: 'ok',
      homeLink: 'ok',
      origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated', scenario: 'clear-day' },
    });
    expect(status.pvW).toBeGreaterThan(0);
    expect(status.rooms.map((r) => r.roomId)).toEqual(['bedroom-1', 'bedroom-2', 'study', 'living']);
    expect(result.content[0]?.text).toMatch(/simulated/i);
  });

  it('is reproducible: the same scenario second gives the same answer', async () => {
    const a = await toolResult(await post(app().handler, callTool('get_home_status', {})));
    const b = await toolResult(await post(app().handler, callTool('get_home_status', {})));
    expect(a.structuredContent).toEqual(b.structuredContent);
  });
});

describe('get_home_status on a visitor sandbox (#101)', () => {
  it('serves a sandbox copy of the demo home, named by the header of a demo#* client', async () => {
    const res = await post(app().handler, callTool('get_home_status', {}), { authorization: `Bearer ${SANDBOX_TOKEN}`, 'x-cold-reserve-home': 'demo#0123456789abcdef' });
    const status = HomeStatusSchema.parse((await toolResult(res)).structuredContent);
    expect(status).toMatchObject({ homeId: 'demo#0123456789abcdef', homeLink: 'ok', controlAvailability: 'ok' });
  });

  it('refuses a new sandbox past MCP_SANDBOX_MAX_NEW_PER_DAY', async () => {
    const { handler } = app({ ...ENV, MCP_SANDBOX_MAX_NEW_PER_DAY: '1' });
    const ask = (home: string) => post(handler, callTool('get_home_status', {}), { authorization: `Bearer ${SANDBOX_TOKEN}`, 'x-cold-reserve-home': home });
    expect((await ask('demo#0123456789abcdef')).status).toBe(200);
    expect((await ask('demo#fedcba9876543210')).status).toBe(429);
  });
});

describe('the get_home_status text', () => {
  it('#271: the demo names its fictional grandpa, the real home never names anyone', async () => {
    const textOf = async (headers: Record<string, string> = {}) => {
      const result = await toolResult(await post(app().handler, callTool('get_home_status', {}), headers));
      return result.content[0]?.text ?? '';
    };
    expect(await textOf()).toContain('Leo (grandpa)');
    const real = await textOf({ authorization: `Bearer ${HOME_TOKEN}` });
    expect(real).toContain('grandpa');
    expect(real).not.toContain('Leo');
  });

  const status = (grid: { gridAvailable: boolean; gridW: number }) => ({ batterySocPct: 10, level: 'essential', rooms: [], origin: { energy: 'simulated' }, homeLink: 'ok', ...grid }) as unknown as HomeStatus;

  it('lists every room as "Name (id)" with whether it is served or waiting, so the model never guesses an id (#274)', () => {
    const s = {
      batterySocPct: 100, level: 'comfort', origin: { energy: 'simulated' }, homeLink: 'ok', gridAvailable: true, gridW: 300,
      rooms: [
        { roomId: 'bedroom-1', state: 'served', occupants: [] },
        { roomId: 'living', state: 'waiting', waitingReason: 'level', occupants: [] },
      ],
    } as unknown as HomeStatus;
    const text = homeStatusSummary(s, 'Europe/Rome', { 'bedroom-1': 'Bedroom', living: 'Living room' });
    expect(text).toContain('Rooms: Bedroom (bedroom-1) served, Living room (living) waiting.');
  });

  it('#271: says who is in each room, a fictional name with its role, "Leo (grandpa)"', () => {
    const s = {
      batterySocPct: 100, level: 'comfort', origin: { energy: 'simulated' }, homeLink: 'ok', gridAvailable: true, gridW: 300,
      rooms: [
        { roomId: 'bedroom-1', state: 'served', occupants: ['grandpa'] },
        { roomId: 'study', state: 'served', occupants: ['adult'] },
      ],
    } as unknown as HomeStatus;
    const text = homeStatusSummary(s, 'Europe/Rome', { 'bedroom-1': 'Bedroom', study: 'Study' }, { grandpa: 'Leo' });
    expect(text).toContain('Rooms: Bedroom (bedroom-1) served with Leo (grandpa), Study (study) served with adult.');
  });

  it('says whether the grid is on, in words, with what it draws or takes (#273): the model reads only the text', () => {
    expect(homeStatusSummary(status({ gridAvailable: true, gridW: 775 }), 'Europe/Rome')).toContain('The grid is on: the home draws 775 W from it.');
    expect(homeStatusSummary(status({ gridAvailable: true, gridW: -1200 }), 'Europe/Rome')).toContain('The grid is on: the home sends 1200 W to it.');
    expect(homeStatusSummary(status({ gridAvailable: false, gridW: 0 }), 'Europe/Rome')).toContain('The grid is down: the home runs on the battery and the sun.');
  });

  it('says the last live reading as the clock time of the home, never an ISO stamp (#177 review)', () => {
    const s = { batterySocPct: 40, level: 'essential', rooms: [], origin: { energy: 'simulated' }, homeLink: 'lost', lastLiveAt: '2026-07-17T19:30:00.000Z' } as unknown as HomeStatus;
    const text = homeStatusSummary(s, 'Europe/Rome');
    expect(text).toContain('Home link lost, last live reading at 9:30 PM.');
    expect(text).not.toMatch(/\d{4}-\d\d-\d\dT/);
  });
});

describe('get_home_status on the real home (FallbackSource, no live data yet)', () => {
  it('falls back to the simulator and says so: homeLink lost, all groups simulated, manual control only', async () => {
    const res = await post(app().handler, callTool('get_home_status', {}), { authorization: `Bearer ${HOME_TOKEN}` });
    const status = HomeStatusSchema.parse((await toolResult(res)).structuredContent);
    expect(status).toMatchObject({ homeId: 'home', homeLink: 'lost', controlAvailability: 'manual_only' });
    expect([status.origin.energy, status.origin.rooms, status.origin.weather]).toEqual(['simulated', 'simulated', 'simulated']);
  });

  it('logs the switch to the simulator once, in the shared log line (#113)', async () => {
    const { handler, logs } = app();
    await post(handler, callTool('get_home_status', {}), { authorization: `Bearer ${HOME_TOKEN}` });
    await post(handler, callTool('get_home_status', {}), { authorization: `Bearer ${HOME_TOKEN}` });
    const switches = logs.filter((l) => l.details?.['event'] === 'HOME_UNREACHABLE');
    expect(switches).toHaveLength(1);
    expect(LogEntrySchema.parse(switches[0])).toMatchObject({ level: 'warn', component: 'mcp-server', homeId: 'home', details: { homeLink: 'lost' } });
  });
});

describe('logSourceEvent (#113)', () => {
  const at = '2026-07-15T12:00:00.000Z';
  const lines = (event: SourceEvent) => {
    const logs: LogEntry[] = [];
    logSourceEvent({ log: (e) => logs.push(e) }, homeId('home'))(event);
    return logs.map((l) => LogEntrySchema.parse(l));
  };

  it('a lost home is a warning with the reason, its category, and the name of what was thrown', () => {
    expect(lines({ type: 'HOME_UNREACHABLE', at, homeLink: 'lost', reason: 'unexpected_error', errorName: 'TypeError' })[0]).toMatchObject({
      ts: at, level: 'warn', code: 'unexpected_error', category: 'internal', errorName: 'TypeError', homeId: 'home',
    });
  });

  it('a simulator failure is an error; the way back is an info line', () => {
    expect(lines({ type: 'FALLBACK_FAILED', at, code: 'missing_eps_load' })[0]).toMatchObject({ level: 'error', code: 'missing_eps_load', category: 'internal' });
    expect(lines({ type: 'HOME_REACHABLE', at })[0]).toMatchObject({ level: 'info' });
  });
});

describe('get_home_status failure paths', () => {
  it('returns isError + home_not_found when the token points to a home that is not configured', async () => {
    const res = await post(app().handler, callTool('get_home_status', {}), { authorization: `Bearer ${'n'.repeat(32)}` });
    const result = await toolResult(res);
    expect(result.isError).toBe(true);
    expect(ErrorEnvelopeSchema.parse(result.structuredContent)).toMatchObject({ code: 'home_not_found', category: 'not_found' });
  });

  it('passes a data-source failure through as a retryable tool error and logs it', async () => {
    const failing = { snapshot: () => Promise.resolve(err(toolError('home_data_stale', 'No home data right now.', { retryAfterMs: 60_000 }))) };
    const { handler, logs } = app(ENV, { sourceOverride: () => failing });
    const result = await toolResult(await post(handler, callTool('get_home_status', {})));
    expect(result.structuredContent).toMatchObject({ code: 'home_data_stale', retryable: true, retryAfterMs: 60_000 });
    expect(logs.filter((l) => l.level !== 'info').map((l) => l.code)).toEqual(['home_data_stale']);
  });

  it('rejects any argument: the home comes from the token', async () => {
    const result = await toolResult(await post(app().handler, callTool('get_home_status', { homeId: 'home' })));
    expect(result.structuredContent).toMatchObject({ code: 'invalid_input' });
  });
});

describe('createApp', () => {
  it.each(['MCP_SCENARIO_START_H', 'MCP_SCENARIO_SPEED'])('fails with invalid_config when %s is empty or not a number', (key) => {
    for (const value of ['', ' ', 'fast', '-1']) {
      const result = createApp({ ...ENV, [key]: value }, { wallClock: fixedClock(WALL), logger: { log: () => undefined } });
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    }
  });

  it('fails with invalid_config on an unknown scenario', () => {
    const result = createApp({ ...ENV, MCP_SCENARIO: 'volcano' }, { wallClock: fixedClock(WALL), logger: { log: () => undefined } });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});

describe('tools/list of the production registry', () => {
  it('matches the snapshot (names, annotations, input and output JSON Schemas)', async () => {
    const body = (await (await post(app().handler, toolsList)).json()) as { result: unknown };
    expect(body.result).toMatchSnapshot();
  });

  it('marks get_home_status read-only and non-destructive', async () => {
    const body = (await (await post(app().handler, toolsList)).json()) as { result: { tools: { name: string; annotations: unknown }[] } };
    expect(body.result.tools.find((t) => t.name === 'get_home_status')?.annotations).toMatchObject({
      readOnlyHint: CARD_TOOL_ACCESS.get_home_status === 'read',
      destructiveHint: false,
    });
  });
});
