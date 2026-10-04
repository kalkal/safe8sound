import { ApplyPlanOutputSchema, ErrorEnvelopeSchema, PlanSchema, ReserveOutlookSchema } from '@cold-reserve/contracts';
import { fixedClock } from '@cold-reserve/core';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { comfortPlanWiring } from '../../src/comfort-plan-config.js';
import { startNodeServer } from '../../src/node-server.js';
import { loadPreferencesConfig, preferencesConfigFile } from '../../src/preferences-config.js';
import { HOME_TOKEN, TOKEN, quietNotifier } from '../helpers.js';

// The hot-day and storm flows end to end: the official SDK client over real HTTP, the production
// registry with the comfort-plan module, the seeded simulator and F5's in-memory store. Model turns are
// scripted.

const textOf = (r: Record<string, unknown>): string => (r['content'] as { type: string; text: string }[] | undefined)?.[0]?.text ?? '';

const wall = fixedClock(Date.parse('2026-09-30T10:00:00Z'));

async function withServer<T>(env: Record<string, string>, run: (call: (token: string, name: string, args: Record<string, unknown>) => Promise<Awaited<ReturnType<Client['callTool']>>>) => Promise<T>): Promise<T> {
  const preferences = loadPreferencesConfig(preferencesConfigFile());
  if (!preferences.ok) throw new Error(preferences.error.message);
  const comfortPlan = comfortPlanWiring({ storeFor: memoryStateStoreFactory({ backing: createMemoryBacking(), clock: wall }), preferences: preferences.value, clock: wall, notifier: quietNotifier });
  if (!comfortPlan.ok) throw new Error(comfortPlan.error.message);
  const app = createApp({ MCP_CLIENTS: `agent@demo=${TOKEN},video@home=${HOME_TOKEN}`, ...env }, { wallClock: wall, logger: { log: () => undefined }, comfortPlan: comfortPlan.value });
  if (!app.ok) throw new Error(app.error.message);
  const server = await startNodeServer(app.value.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: app.value.config.maxBodyBytes });
  const clients: Client[] = [];
  const call = async (token: string, name: string, args: Record<string, unknown>) => {
    const client = new Client({ name: 'e2e-comfort', version: '0.0.0' });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    // SDK v1 types do not satisfy exactOptionalPropertyTypes (sessionId?: string vs undefined).
    await client.connect(transport as unknown as Transport);
    await client.listTools(); // loads the output validators, as a real agent would
    return client.callTool({ name, arguments: args });
  };
  try {
    return await run(call);
  } finally {
    for (const c of clients) await c.close();
    await server.close();
  }
}

describe('hot day (heatwave, 14:00): propose, the guard says no, re-plan, confirm, retry', () => {
  it('runs the whole flow through MCP', async () => {
    await withServer({ MCP_SCENARIO: 'heatwave', MCP_SCENARIO_START_H: '14' }, async (call) => {
      // 1. The model proposes "every room at 22 °C": the guard refuses it, and the answer is the plan that holds,
      // saved and ready to apply, with the refusal said first (#202).
      const greedy = await call(TOKEN, 'plan_comfort', { goal: 'cool', setpointC: 22, roomIds: ['bedroom-1', 'bedroom-2', 'living', 'study'] });
      expect(greedy.isError).toBeFalsy();
      const holds = PlanSchema.parse(greedy.structuredContent);
      expect(holds.refusedProposal?.code).toBe('inverter_limit_exceeded');
      expect(holds.guarantees.every((g) => g.ok)).toBe(true);
      expect(textOf(greedy)).toMatch(/^The guard refused the proposed setpoint and rooms: .*Nearest allowed: 6000 W\. This plan holds instead and is ready to apply\./);
      expect(textOf(greedy)).toContain(`call apply_plan with planId ${holds.id}`);

      // 2. It asks the planner instead: the most comfortable plan the guard accepts.
      const proposed = await call(TOKEN, 'plan_comfort', { goal: 'cool' });
      expect(proposed.isError).toBeFalsy();
      const plan = PlanSchema.parse(proposed.structuredContent);
      expect(plan.guarantees.every((g) => g.ok)).toBe(true);
      // What the agent actually reads: the text content, with the facts it may say.
      const text = textOf(proposed);
      expect(text).toContain(plan.id);
      expect(text).toContain('storm_reserve holds');
      expect(text).toMatch(/Without the plan the safe room \(bedroom-1\) would peak at \d+(\.\d)? °C/);
      expect(text).toContain('simulated data');
      // The 36-hour heatwave shows the whole night: the night-recovery guarantee is met and said with its hours.
      expect(plan.nightRecovery?.status).toBe('met');
      expect(text).toMatch(/Night recovery \(elderly\) met: [\d.]+ of 6 hours at or below 24 °C/);
      expect(text).toMatch(/What it does: Bedroom: (cool|dry) at \d+(\.\d)? °C/);
      expect(plan.counterfactual?.scenarios.noPlan.peakTempC).toBeGreaterThan(plan.counterfactual?.scenarios.plan.peakTempC ?? Infinity);
      // An ordinary summer day (#203): the battery is full at 2 PM, so the solar surplus cools the house instead
      // of going to the grid, the safe room first; the text says where, in order, and the kWh kept at home.
      const surplus = plan.surplus;
      if (surplus === undefined) throw new Error('no solar surplus on the hot day');
      expect(surplus.rooms[0]?.reason).toBe('safe_room');
      expect(text).toMatch(/Solar surplus from \d{1,2}:\d\d [AP]M to \d{1,2}:\d\d [AP]M: [\d.]+ kWh kept at home instead of exported to the grid\. Where it went, in order: 1\) Bedroom \(safe room\), cooled to [\d.]+ °C/);
      expect(text).toContain(`${surplus.keptKWh.toFixed(1)} kWh kept at home`);

      // 3. The person confirms; the agent retries after a timeout: one application only.
      const first = await call(TOKEN, 'apply_plan', { planId: plan.id });
      const again = await call(TOKEN, 'apply_plan', { planId: plan.id });
      const applied = ApplyPlanOutputSchema.parse(first.structuredContent);
      const retried = ApplyPlanOutputSchema.parse(again.structuredContent);
      expect([applied.alreadyApplied, retried.alreadyApplied]).toEqual([false, true]);
      expect(retried.plan).toEqual(applied.plan);
      expect(textOf(first)).toBe(`Plan ${plan.id} applied.`);
      expect(textOf(again)).toBe(`Plan ${plan.id} was already applied.`);

      // 4. The ice cubes.
      const ice = await call(TOKEN, 'get_reserve_outlook', {});
      const outlook = ReserveOutlookSchema.parse(ice.structuredContent);
      expect(outlook.hoursAtEssential).toBeGreaterThanOrEqual(outlook.hoursAtCurrentLevel);
      expect(textOf(ice)).toContain(`about ${outlook.hoursAtCurrentLevel.toFixed(1)} hours at ${outlook.level} level, or ${outlook.hoursAtEssential.toFixed(1)} hours at essential`);
      expect(textOf(ice)).toContain('simulated data');
    });
  });

  it('the real home never applies a plan built on simulated data', async () => {
    await withServer({ MCP_SCENARIO: 'heatwave', MCP_SCENARIO_START_H: '14' }, async (call) => {
      const plan = PlanSchema.parse((await call(HOME_TOKEN, 'plan_comfort', { goal: 'cool' })).structuredContent);
      expect(plan.advisoryOnly).toBe(true);
      const refused = await call(HOME_TOKEN, 'apply_plan', { planId: plan.id });
      expect(refused.isError).toBe(true);
      expect(ErrorEnvelopeSchema.parse(refused.structuredContent)).toMatchObject({ code: 'simulated_plan_on_real_home', category: 'forbidden' });
    });
  });
});

describe('storm (the grid is down at 15:00)', () => {
  it('on the EPS circuits alone, keeps the safe room at comfort until the recharge, cooler than the naive plan', async () => {
    await withServer({ MCP_SCENARIO: 'storm-blackout', MCP_SCENARIO_START_H: '3' }, async (call) => {
      const r = await call(TOKEN, 'plan_comfort', { goal: 'cool' });
      expect(r.isError).toBeFalsy();
      const plan = PlanSchema.parse(r.structuredContent);
      expect(plan.guarantees.every((g) => g.ok)).toBe(true);
      expect(plan.guarantees.find((g) => g.id === 'pacing_on_track')?.reason).toMatch(/lasts until the next recharge/);
      expect(textOf(r)).toContain(`Storm reserve ${(plan.reserveWh / 1000).toFixed(1)} kWh.`);
      expect(textOf(r)).not.toContain('while the grid is up');
      expect(plan.guarantees.find((g) => g.id === 'storm_reserve')?.reason).toMatch(/grid is down/);
      expect(plan.nightRecovery?.status).toBe('met');
      const c = plan.counterfactual;
      // Until 2026-10-01 the projection drew the whole house's base load from the battery in a blackout, so
      // the naive plan (the scenario's own dry 27 °C) ran it empty before dawn and this plan had to be paced.
      // Off grid only the EPS circuits are powered now (150 W besides the safe room's split): the naive plan
      // lasts, but it holds the room at its 27 °C limit, while ours keeps it at 26 °C with no heat stress.
      expect(c?.scenarios.naive.peakTempC).toBeGreaterThan(c?.scenarios.plan.peakTempC ?? Infinity);
      expect(c?.scenarios.naive.heatIndexDegreeHours).toBeGreaterThan(c?.scenarios.plan.heatIndexDegreeHours ?? Infinity);
      expect(c?.scenarios.plan.heatIndexDegreeHours).toBe(0);
    });
  });
});
