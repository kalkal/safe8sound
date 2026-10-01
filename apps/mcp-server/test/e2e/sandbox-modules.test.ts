import { fixedClock } from '@cold-reserve/core';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { comfortPlanWiring } from '../../src/comfort-plan-config.js';
import { composeModules } from '../../src/compose.js';
import { startNodeServer } from '../../src/node-server.js';
import { loadPreferencesConfig, preferencesConfigFile } from '../../src/preferences-config.js';
import { stormModeWiring } from '../../src/storm-mode-config.js';
import { TOKEN } from '../helpers.js';

// A visitor sandbox (#101) is served by every module, not only by the store: energy-status,
// comfort-plan, preferences and storm-mode all resolve demo#<16 hex>. Wired like src/local.ts.

const wall = fixedClock(Date.parse('2026-09-30T10:00:00Z'));
const SANDBOX = 'demo#0123456789abcdef';

describe('visitor sandbox through every module', () => {
  it('answers get_home_status, plan_comfort, get_preferences and get_safe_room_status for a demo# home', async () => {
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
    const client = new Client({ name: 'e2e-sandbox', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, 'x-cold-reserve-home': SANDBOX } } });
    try {
      // SDK v1 types do not satisfy exactOptionalPropertyTypes (sessionId?: string vs undefined).
      await client.connect(transport as unknown as Transport);
      await client.listTools();
      for (const name of ['get_home_status', 'plan_comfort', 'get_preferences', 'get_safe_room_status']) {
        const result = await client.callTool({ name, arguments: name === 'plan_comfort' ? { goal: 'cool' } : {} });
        expect({ name, isError: result.isError ?? false }).toEqual({ name, isError: false });
        expect(JSON.stringify(result)).not.toContain('home_not_found');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
