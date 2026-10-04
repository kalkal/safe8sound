import { ApplyPlanOutputSchema, PlanSchema, SafeRoomStatusSchema, epochMs } from '@cold-reserve/contracts';
import { memoryLogger, seededRng } from '@cold-reserve/core';
import { builtInScenario } from '@cold-reserve/source-simulator';
import { dynamoStateStoreFactory } from '@cold-reserve/store-dynamodb';
import { createFakeTable } from '@cold-reserve/store-dynamodb/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { createLambdaApp } from '../../src/lambda-app.js';
import { startNodeServer } from '../../src/node-server.js';
import { settableClock } from '../comfort-plan/support.js';
import { TOKEN } from '../helpers.js';

// #175: the Lambda's domain runs on the scenario clock, like the local entry, while the DynamoDB store keeps the wall
// clock for its TTL. Real time is October, the scenario is a July day: a plan is made at scenario time, lives ten
// scenario minutes, and its item is kept for its retention from the write, not deleted months early.

const H = 3_600_000;
const MIN = 60_000;
const DAY_S = 24 * 60 * 60;
const WALL = Date.parse('2026-10-04T10:00:00Z');

describe('Lambda composition: domain on the scenario clock, store TTL on the wall clock', () => {
  it('plans, applies and reports safe hours on the scenario day; the plan item keeps a wall-clock TTL; logs on the wall', async () => {
    const wall = settableClock(WALL);
    const table = createFakeTable();
    const storeFor = dynamoStateStoreFactory({ table, clock: wall, rng: seededRng(1) });
    const logger = memoryLogger();
    const env = { MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_SCENARIO: 'storm-blackout', MCP_SCENARIO_START_H: '4' };
    const lambda = createLambdaApp(env, { wallClock: wall, logger, storeFor });
    if (!lambda.ok) throw new Error(lambda.error.message);
    const server = await startNodeServer(lambda.value.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: lambda.value.config.maxBodyBytes });
    const client = new Client({ name: 'e2e-lambda-clock', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }) as unknown as Transport);
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const scenarioNow = Date.parse(builtInScenario('storm-blackout').startAt) + 4 * H;
    try {
      const plan = PlanSchema.parse((await call('plan_comfort', { goal: 'cool' })).structuredContent);
      expect(Math.abs(Date.parse(plan.createdAt) - scenarioNow)).toBeLessThan(MIN);
      expect(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt)).toBe(10 * MIN);
      expect(plan.steps.every((s) => s.ts.startsWith('2026-07-'))).toBe(true);
      expect(await table.get('HOME#demo', `PLAN#${plan.id}`)).toMatchObject({ ttl: WALL / 1000 + 30 * DAY_S, expiresAtMs: epochMs(plan.expiresAt) });

      const applied = await call('apply_plan', { planId: plan.id });
      expect(applied.isError).not.toBe(true);
      expect(ApplyPlanOutputSchema.parse(applied.structuredContent).plan.status).toBe('applied');

      const status = SafeRoomStatusSchema.parse((await call('get_safe_room_status')).structuredContent);
      expect(status.safeUntil.startsWith('2026-07-')).toBe(true);

      // Ten scenario minutes later (speed 1: ten wall minutes) a new plan has expired on scenario time.
      const late = PlanSchema.parse((await call('plan_comfort', { goal: 'cool' })).structuredContent);
      wall.set(WALL + 10 * MIN);
      const refused = await call('apply_plan', { planId: late.id });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({ code: 'plan_expired' });

      expect(logger.lines.length).toBeGreaterThan(0);
      expect(logger.lines.every((l) => l.ts.startsWith('2026-10-04'))).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // The AWS settings: MCP_SCENARIO_ANCHOR=daily (infra/cdk.json). Two cases tell the clocks apart (#236 review).
  async function lambdaOn(env: Record<string, string>, wallMs: number) {
    const wall = settableClock(wallMs);
    const table = createFakeTable();
    const lambda = createLambdaApp({ MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_SCENARIO_ANCHOR: 'daily', ...env }, { wallClock: wall, logger: memoryLogger(), storeFor: dynamoStateStoreFactory({ table, clock: wall, rng: seededRng(2) }) });
    if (!lambda.ok) throw new Error(lambda.error.message);
    const server = await startNodeServer(lambda.value.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: lambda.value.config.maxBodyBytes });
    const client = new Client({ name: 'e2e-lambda-daily', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }) as unknown as Transport);
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    return { wall, call, close: async () => { await client.close(); await server.close(); } };
  }

  it('speed 2: a plan expires after ten scenario minutes, five wall minutes, on scenario time', async () => {
    // 07:00 in Rome: at speed 2 the heatwave day reads 14:00.
    const { wall, call, close } = await lambdaOn({ MCP_SCENARIO: 'heatwave', MCP_SCENARIO_SPEED: '2' }, Date.parse('2026-10-04T05:00:00Z'));
    try {
      const plan = PlanSchema.parse((await call('plan_comfort', { goal: 'cool' })).structuredContent);
      expect(plan.createdAt.startsWith('2026-07-16')).toBe(true);
      wall.set(Date.parse('2026-10-04T05:05:00Z') - 1);
      expect((await call('apply_plan', { planId: plan.id })).isError).not.toBe(true);
      const late = PlanSchema.parse((await call('plan_comfort', { goal: 'cool' })).structuredContent);
      wall.set(Date.parse('2026-10-04T05:10:00Z'));
      expect((await call('apply_plan', { planId: late.id })).structuredContent).toMatchObject({ code: 'plan_expired' });
    } finally {
      await close();
    }
  });

  it('the scenario day replays every day, but yesterday plan never comes back in the same minutes', async () => {
    // 22:00 in Rome (20:00 UTC): the plan lives until 22:10 of the scenario day, which replays tomorrow.
    const { wall, call, close } = await lambdaOn({ MCP_SCENARIO: 'clear-day' }, Date.parse('2026-10-04T20:00:00Z'));
    try {
      const plan = PlanSchema.parse((await call('plan_comfort', { goal: 'cool' })).structuredContent);
      // A day later at 22:05 scenario time is again before the plan's expiry; a day of wall time has passed.
      wall.set(Date.parse('2026-10-05T20:05:00Z'));
      expect((await call('apply_plan', { planId: plan.id })).structuredContent).toMatchObject({ code: 'plan_expired' });
      // Control: a plan made today in the same minutes applies.
      const today = PlanSchema.parse((await call('plan_comfort', { goal: 'cool' })).structuredContent);
      expect((await call('apply_plan', { planId: today.id })).isError).not.toBe(true);
    } finally {
      await close();
    }
  });

  it('a bad scenario setting stops the start, as on the local entry', () => {
    const storeFor = dynamoStateStoreFactory({ table: createFakeTable(), clock: { now: () => WALL }, rng: seededRng(1) });
    expect(createLambdaApp({ MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_SCENARIO_ANCHOR: 'tomorrow' }, { wallClock: { now: () => WALL }, logger: memoryLogger(), storeFor })).toMatchObject({
      ok: false,
      error: { code: 'invalid_config' },
    });
  });
});
