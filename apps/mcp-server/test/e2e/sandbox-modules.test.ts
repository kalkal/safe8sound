import { ErrorEnvelopeSchema, HOME_HEADER, PlanSchema } from '@cold-reserve/contracts';
import { fixedClock } from '@cold-reserve/core';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { comfortPlanWiring } from '../../src/comfort-plan-config.js';
import { composeModules } from '../../src/compose.js';
import { startNodeServer } from '../../src/node-server.js';
import { loadPreferencesConfig, preferencesConfigFile } from '../../src/preferences-config.js';
import { stormModeWiring } from '../../src/storm-mode-config.js';
import { TOKEN } from '../helpers.js';

// Visitor sandboxes (#101) over real HTTP, wired like src/local.ts: every module resolves demo#<16 hex>
// (R2 of the 2026-10-01 architecture check), and two sandboxes never see each other's data.

const wall = fixedClock(Date.parse('2026-09-30T10:00:00Z'));
const SANDBOX_A = 'demo#0123456789abcdef';
const SANDBOX_B = 'demo#fedcba9876543210';
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function startServer() {
  const preferences = loadPreferencesConfig(preferencesConfigFile());
  if (!preferences.ok) throw new Error(preferences.error.message);
  const storeFor = memoryStateStoreFactory({ backing: createMemoryBacking(), clock: wall });
  const modules = composeModules({ preferences: preferences.value, storeFor, clock: wall });
  const comfortPlan = comfortPlanWiring({ storeFor, preferences: preferences.value, clock: wall });
  const stormMode = stormModeWiring({ storeFor, preferences: preferences.value, clock: wall });
  if (!modules.ok) throw new Error(modules.error.message);
  if (!comfortPlan.ok) throw new Error(comfortPlan.error.message);
  if (!stormMode.ok) throw new Error(stormMode.error.message);
  const app = createApp(
    { MCP_CLIENTS: `agent@demo#*=${TOKEN}`, MCP_SCENARIO: 'heatwave', MCP_SCENARIO_START_H: '14' },
    { wallClock: wall, logger: { log: () => undefined }, modules: modules.value, comfortPlan: comfortPlan.value, stormMode: stormMode.value },
  );
  if (!app.ok) throw new Error(app.error.message);
  const server = await startNodeServer(app.value.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: app.value.config.maxBodyBytes });
  cleanup.push(() => server.close());

  /** An MCP client for one sandbox: the agent token, with that sandbox in the home header. */
  return async (home: string) => {
    const client = new Client({ name: `e2e-${home}`, version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, [HOME_HEADER]: home } } });
    // SDK v1 types do not satisfy exactOptionalPropertyTypes (sessionId?: string vs undefined).
    await client.connect(transport as unknown as Transport);
    await client.listTools();
    cleanup.push(() => client.close());
    return (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  };
}

describe('visitor sandboxes through every module', () => {
  it('answers get_home_status, plan_comfort, get_preferences and get_safe_room_status for a demo# home', async () => {
    const call = await (await startServer())(SANDBOX_A);
    for (const name of ['get_home_status', 'plan_comfort', 'get_preferences', 'get_safe_room_status']) {
      const result = await call(name, name === 'plan_comfort' ? { goal: 'cool' } : {});
      expect({ name, isError: result.isError ?? false }).toEqual({ name, isError: false });
      expect(JSON.stringify(result)).not.toContain('home_not_found');
    }
  });

  it('keeps two sandboxes apart: preferences and plans of A are invisible from B', async () => {
    const clientFor = await startServer();
    const [a, b] = [await clientFor(SANDBOX_A), await clientFor(SANDBOX_B)];

    const defaults = await b('get_preferences');
    const saved = await a('set_preferences', { comfortC: { cooling: 24 }, language: 'it-IT', confirmed: true });
    expect(saved.isError).toBeFalsy();
    expect(await a('get_preferences')).toMatchObject({ structuredContent: { preferences: { comfortC: { cooling: 24 }, language: 'it-IT' } } });
    expect((await b('get_preferences')).structuredContent).toEqual(defaults.structuredContent);

    const plan = PlanSchema.parse((await a('plan_comfort', { goal: 'cool' })).structuredContent);
    expect(plan.homeId).toBe(SANDBOX_A);
    const foreign = await b('apply_plan', { planId: plan.id });
    expect(foreign.isError).toBe(true);
    expect(ErrorEnvelopeSchema.parse(foreign.structuredContent).code).toBe('plan_not_found');
    expect((await a('apply_plan', { planId: plan.id })).isError).toBeFalsy();
  });
});
