import './no-network.js';
import { HomeIdSchema, PlanSchema } from '@cold-reserve/contracts';
import { examplePlan } from '@cold-reserve/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import { McpToken } from '../src/config.js';
import { createTurnRecorder, mcpRequestHeaders, mcpToolset, withCorrelationHeader, type McpSession } from '../src/mcp-tools.js';

const PLAN = PlanSchema.parse(examplePlan()) as unknown as Record<string, unknown>;
const STATUS = {
  homeId: 'demo#0123456789abcdef',
  ts: '2026-07-15T12:00:00.000Z',
  batterySocPct: 45,
  origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated' },
};

/** A fake MCP server: records every call with its arguments. */
function fakeSession(results: Record<string, { text: string; structuredContent?: Record<string, unknown>; isError?: boolean }>) {
  const calls: { name: string; args: unknown; correlationId?: string | undefined }[] = [];
  const session: McpSession = {
    listTools: () =>
      Promise.resolve(Object.keys(results).map((name) => ({ name, description: `The ${name} tool.`, inputSchema: { type: 'object' as const, properties: {} } }))),
    callTool: (name, args, _signal, correlationId) => {
      calls.push({ name, args, ...(correlationId === undefined ? {} : { correlationId }) });
      const r = results[name] ?? { text: 'unknown', isError: true };
      return Promise.resolve({ content: [{ type: 'text', text: r.text }], ...(r.structuredContent ? { structuredContent: r.structuredContent } : {}), ...(r.isError ? { isError: true } : {}) });
    },
  };
  return { session, calls };
}

const run = async (tools: Awaited<ReturnType<typeof mcpToolset>>, name: string, input: unknown) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const result = await tool.invoke(input);
  return result;
};

describe('mcpToolset: our own MCP wrapper (approved in #101)', () => {
  it('offers every server tool to the model with its description and input schema', async () => {
    const { session } = fakeSession({ get_home_status: { text: 'Battery at 45%.' }, plan_comfort: { text: 'Plan proposed.' } });
    const tools = await mcpToolset(session, createTurnRecorder());
    expect(tools.map((t) => [t.name, t.description])).toEqual([
      ['get_home_status', 'The get_home_status tool.'],
      ['plan_comfort', 'The plan_comfort tool.'],
    ]);
  });

  it('gives the model the text, and records structuredContent only for the card tools', async () => {
    const { session } = fakeSession({
      plan_comfort: { text: 'Plan proposed.', structuredContent: PLAN },
      get_home_status: { text: 'Battery at 45%.', structuredContent: STATUS },
      get_energy_forecast: { text: 'Hot tomorrow.', structuredContent: { secretish: 1 } },
    });
    const recorder = createTurnRecorder();
    const tools = await mcpToolset(session, recorder);
    expect(await run(tools, 'plan_comfort', { goal: 'cool' })).toBe('Plan proposed.');
    await run(tools, 'get_home_status', {});
    await run(tools, 'get_energy_forecast', {});
    expect(recorder.cards()).toEqual([{ tool: 'plan_comfort', result: PLAN }]);
    expect(recorder.status()).toEqual({ batterySocPct: 45, origin: STATUS.origin, ts: STATUS.ts });
  });

  it('shows the safe-room card too; the floor plan is not a card on every status answer (#24, #171)', async () => {
    const SAFE_ROOM = {
      safeRoomId: 'bedroom-1',
      tempC: 26.8,
      occupantRoles: ['grandpa'],
      level: 'essential',
      levelReason: 'storm',
      safeHours: 10,
      safeUntil: '2026-07-18T06:40:00+02:00',
      stormPhase: 'active',
      origin: STATUS.origin,
      homeLink: 'ok',
    };
    const { session } = fakeSession({ get_safe_room_status: { text: 'Safe room.', structuredContent: SAFE_ROOM } });
    const recorder = createTurnRecorder();
    await run(await mcpToolset(session, recorder), 'get_safe_room_status', {});
    expect(recorder.cards()).toEqual([{ tool: 'get_safe_room_status', result: SAFE_ROOM }]);
  });

  it('drops a card whose result breaks its contract (one bad card never costs the answer)', async () => {
    const { session } = fakeSession({ plan_comfort: { text: 'Plan proposed.', structuredContent: { id: 'not-a-plan' } } });
    const recorder = createTurnRecorder();
    expect(await run(await mcpToolset(session, recorder), 'plan_comfort', {})).toBe('Plan proposed.');
    expect(recorder.cards()).toEqual([]);
  });

  it('turns an MCP tool error into an error result for the model, with no card', async () => {
    const { session } = fakeSession({ apply_plan: { text: 'The plan expired.', structuredContent: { code: 'plan_expired' }, isError: true } });
    const recorder = createTurnRecorder();
    const tools = await mcpToolset(session, recorder);
    await expect(run(tools, 'apply_plan', { planId: 'plan-0001' })).rejects.toThrow('The plan expired.');
    expect(recorder.cards()).toEqual([]);
  });

  it('a guard refusal with its verdict becomes the plan card (REJECTED receipt), and the model still gets the error text (#186)', async () => {
    const rows = ['storm_reserve', 'inverter_limit', 'battery_power', 'safe_room_comfort', 'pacing_on_track'].map((id) => ({ id, ok: id !== 'inverter_limit', reason: 'r' }));
    const refusal = { code: 'inverter_limit_exceeded', category: 'guard_rejection', message: 'Peak load too high. Nearest allowed: 6000 W.', retryable: false, details: { guarantee: 'inverter_limit', guarantees: rows } };
    const { session } = fakeSession({ plan_comfort: { text: refusal.message, structuredContent: refusal, isError: true } });
    const recorder = createTurnRecorder();
    const tools = await mcpToolset(session, recorder);
    await expect(run(tools, 'plan_comfort', { goal: 'cool' })).rejects.toThrow('Nearest allowed: 6000 W.');
    expect(recorder.cards()).toEqual([{ tool: 'plan_comfort', result: refusal }]);
  });

  it('keeps at most one refusal card per answer, the last, even when the cards are full (#202)', () => {
    const rows = ['storm_reserve', 'inverter_limit', 'battery_power', 'safe_room_comfort', 'pacing_on_track'].map((id) => ({ id, ok: id !== 'inverter_limit', reason: 'r' }));
    const refusal = (message: string) => ({ code: 'inverter_limit_exceeded', category: 'guard_rejection', message, retryable: false, details: { guarantee: 'inverter_limit', guarantees: rows } });
    const recorder = createTurnRecorder();
    recorder.record('plan_comfort', refusal('First.'));
    recorder.record('plan_comfort', PLAN);
    recorder.record('plan_comfort', refusal('Second.'));
    recorder.record('plan_comfort', PLAN);
    recorder.record('plan_comfort', PLAN);
    recorder.record('plan_comfort', refusal('Third.'));
    const cards = recorder.cards();
    expect(cards).toHaveLength(4);
    const refusals = cards.filter((c) => 'category' in c.result);
    expect(refusals.map((c) => (c.result as { message: string }).message)).toEqual(['Third.']);
    expect(cards.at(-1)?.result).toMatchObject({ message: 'Third.' });
  });

  it('a refusal without its verdict, or an error of another kind, stays text only', async () => {
    const { session } = fakeSession({
      plan_comfort: { text: 'No.', structuredContent: { code: 'inverter_limit_exceeded', category: 'guard_rejection', message: 'No.', retryable: false }, isError: true },
    });
    const recorder = createTurnRecorder();
    const tools = await mcpToolset(session, recorder);
    await expect(run(tools, 'plan_comfort', { goal: 'cool' })).rejects.toThrow('No.');
    expect(recorder.cards()).toEqual([]);
  });

  it('apply_plan as the model sees it has no lastResortToken: the token is the card’s, never the model’s (#201)', async () => {
    const { session, calls } = fakeSession({ apply_plan: { text: 'Plan applied.' } });
    const withToken = { ...session, listTools: async () => (await session.listTools()).map((t) => ({ ...t, inputSchema: { type: 'object' as const, properties: { planId: { type: 'string' }, lastResortToken: { type: 'string', pattern: '^lr_' } }, required: ['planId'] } })) };
    const tools = await mcpToolset(withToken, createTurnRecorder());
    const apply = tools.find((t) => t.name === 'apply_plan');
    expect(JSON.stringify(apply?.toolSpec.inputSchema)).not.toMatch(/lastResortToken|lr_/);
    // A token the model passes anyway (made up, or read somewhere) never reaches the server.
    await run(tools, 'apply_plan', { planId: 'plan-0001', lastResortToken: `lr_${'x'.repeat(30)}` });
    expect(calls[0]?.args).toEqual({ planId: 'plan-0001' });
  });

  it('passes the model arguments through unchanged: a "home" argument is the server\'s problem, never a header', async () => {
    const { session, calls } = fakeSession({ get_home_status: { text: 'ok' } });
    const tools = await mcpToolset(session, createTurnRecorder());
    await run(tools, 'get_home_status', { home: 'home' });
    expect(calls).toEqual([{ name: 'get_home_status', args: { home: 'home' } }]);
  });

  it('sends the correlation id of the turn with every MCP call', async () => {
    const { session, calls } = fakeSession({ get_home_status: { text: 'ok' } });
    const recorder = createTurnRecorder();
    const tools = await mcpToolset(session, recorder);
    recorder.reset('0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60');
    await run(tools, 'get_home_status', {});
    expect(calls).toEqual([{ name: 'get_home_status', args: {}, correlationId: '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60' }]);
  });

  it('starts every turn with no cards', async () => {
    const { session } = fakeSession({ plan_comfort: { text: 'ok', structuredContent: PLAN } });
    const recorder = createTurnRecorder();
    await run(await mcpToolset(session, recorder), 'plan_comfort', {});
    recorder.reset();
    expect(recorder.cards()).toEqual([]);
    expect(recorder.status()).toBeUndefined();
  });
});

describe('mcpRequestHeaders: the sandbox home comes from the code (the invocation), never from the model', () => {
  const token = new McpToken('t'.repeat(32));

  it('sends the bearer token and the home of the invocation', () => {
    expect(mcpRequestHeaders(token, HomeIdSchema.parse('demo#0123456789abcdef'))).toEqual({
      authorization: `Bearer ${'t'.repeat(32)}`,
      'x-cold-reserve-home': 'demo#0123456789abcdef',
    });
  });

  it('sends no home header when the agent serves its own home', () => {
    expect(mcpRequestHeaders(token, undefined)).toEqual({ authorization: `Bearer ${'t'.repeat(32)}` });
  });
});

describe('withCorrelationHeader: x-correlation-id on every MCP HTTP request of the turn', () => {
  it('adds the current id to each request and keeps the other headers', async () => {
    const seen: Headers[] = [];
    let current: string | undefined = 'c-1';
    const fetchFn = withCorrelationHeader((_url, init) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(new Response('{}'));
    }, () => current);
    await fetchFn('http://127.0.0.1:3316/mcp', { headers: { authorization: 'Bearer t' } });
    current = undefined;
    await fetchFn('http://127.0.0.1:3316/mcp', { headers: { authorization: 'Bearer t' } });
    expect(seen.map((h) => [h.get('authorization'), h.get('x-correlation-id')])).toEqual([
      ['Bearer t', 'c-1'],
      ['Bearer t', null],
    ]);
  });
});
