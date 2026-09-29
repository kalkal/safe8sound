import { createMemoryBacking, memoryStateStoreFactory, type MemoryBacking } from '@cold-reserve/store-memory';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { composeModules } from '../../src/compose.js';
import { startNodeServer } from '../../src/node-server.js';
import { loadPreferencesConfig, preferencesConfigFile } from '../../src/preferences-config.js';
import { TOKEN } from '../helpers.js';

// Done criterion of #20: "preferences survive a new browser session". A person saves a change
// through one server instance; a brand-new server instance (new process state, new store object)
// on the same backing data returns it. Both instances start like the local entry does: the shipped
// config/preferences.json, composeModules and the demo home profile.
const clock = { now: () => Date.parse('2026-07-15T12:00:00Z') };

async function session<T>(backing: MemoryBacking, run: (client: Client) => Promise<T>): Promise<T> {
  const preferences = loadPreferencesConfig(preferencesConfigFile());
  if (!preferences.ok) throw new Error(preferences.error.message);
  const modules = composeModules({ preferences: preferences.value, storeFor: memoryStateStoreFactory({ backing, clock }), clock });
  if (!modules.ok) throw new Error(modules.error.message);
  const app = createApp({ MCP_CLIENTS: `agent@demo=${TOKEN}` }, { wallClock: clock, logger: { log: () => undefined }, modules: modules.value });
  if (!app.ok) throw new Error(app.error.message);
  const server = await startNodeServer(app.value.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: app.value.config.maxBodyBytes });
  const client = new Client({ name: 'e2e-preferences', version: '0.0.0' });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } });
    // SDK v1 types do not satisfy exactOptionalPropertyTypes (sessionId?: string vs undefined).
    await client.connect(transport as unknown as Transport);
    await client.listTools();
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('preferences over MCP (SDK client, real HTTP)', () => {
  it('survive a new session on a new server instance', async () => {
    const backing = createMemoryBacking();

    const saved = await session(backing, (client) =>
      client.callTool({ name: 'set_preferences', arguments: { comfortC: { cooling: 24 }, language: 'it-IT', confirmed: true } }),
    );
    expect(saved).toMatchObject({ structuredContent: { preferences: { comfortC: { cooling: 24 }, language: 'it-IT' } } });
    expect(saved.isError).toBeFalsy();

    const read = await session(backing, (client) => client.callTool({ name: 'get_preferences', arguments: {} }));
    expect(read.isError).toBeFalsy();
    expect(read.structuredContent).toMatchObject({ isDefault: false, preferences: { comfortC: { cooling: 24 }, language: 'it-IT' } });
  });
});
