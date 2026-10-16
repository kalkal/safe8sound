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

async function session<T>(backing: MemoryBacking, run: (client: Client) => Promise<T>, unitsFor?: () => 'C' | 'F'): Promise<T> {
  const preferences = loadPreferencesConfig(preferencesConfigFile());
  if (!preferences.ok) throw new Error(preferences.error.message);
  const modules = composeModules({ preferences: preferences.value, storeFor: memoryStateStoreFactory({ backing, clock }), clock, ...(unitsFor === undefined ? {} : { unitsFor }) });
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

describe('heat safety settings over MCP (#266)', () => {
  it('get_preferences shows the bounds; set_preferences keeps a stricter choice and refuses a looser cap', async () => {
    const backing = createMemoryBacking();
    const read = await session(backing, (client) => client.callTool({ name: 'get_preferences', arguments: {} }));
    expect(read.structuredContent).toMatchObject({
      hardLimits: { stricterNightLimit: { default: false }, heatIndexCapC: { min: 26.7, max: 32.2, default: 32.2 }, elderlyCapC: { min: 26, max: 31, default: 31 } },
    });

    const stricter = await session(backing, (client) =>
      client.callTool({ name: 'set_preferences', arguments: { safety: { stricterNightLimit: true, heatIndexCapC: 30 }, confirmed: true } }),
    );
    expect(stricter.isError).toBeFalsy();
    expect(stricter).toMatchObject({ structuredContent: { preferences: { safety: { stricterNightLimit: true, heatIndexCapC: 30 } } } });
    // The model only sees the text: it carries every value it must say.
    const text = (stricter.content as { text: string }[])[0]?.text;
    expect(text).toBe('Saved: safety stricter night limit from false to true, safety heat index cap from 32.2 to 30.');

    // The text names the maximum, the toggle and both caps as played (#266 review).
    const after = await session(backing, (client) => client.callTool({ name: 'get_preferences', arguments: {} }));
    expect((after.content as { text: string }[])[0]?.text).toContain(
      'Safe room limits: at most 27 C, the stricter night limit on, a heat-index cap of 30 C, an older-person cap of 31 C.',
    );

    const looser = await session(backing, (client) => client.callTool({ name: 'set_preferences', arguments: { safety: { elderlyCapC: 33 }, confirmed: true } }));
    expect(looser.isError).toBe(true);
    expect(looser).toMatchObject({ structuredContent: { code: 'safety_threshold_out_of_range', details: { field: 'safety.elderlyCapC', nearestAllowed: 31 } } });
  });
});

describe('preferences in a °F sandbox (#306): said in °F, with the °C value the tools take in brackets', () => {
  const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? '');

  it('get_preferences says every temperature in °F, then the °C to send', async () => {
    const backing = createMemoryBacking();
    const read = text(await session(backing, (client) => client.callTool({ name: 'get_preferences', arguments: {} }), () => 'F'));
    expect(read).toMatch(/cool to \d+(\.\d)? °F \(\d+(\.\d)? C\)/);
    // 27 °C is 80.6 °F; 32.2 °C is 89.96 °F, said 90; 31 °C is 87.8 °F.
    expect(read).toContain('Safe room limits: at most 80.6 °F (27 C), the stricter night limit off, a heat-index cap of 90 °F (32.2 C), an older-person cap of 87.8 °F (31 C).');
  });

  it('set_preferences says each temperature it changed in °F with its °C, and other values as they are', async () => {
    const backing = createMemoryBacking();
    const saved = text(
      await session(backing, (client) => client.callTool({ name: 'set_preferences', arguments: { safety: { stricterNightLimit: true, heatIndexCapC: 30 }, confirmed: true } }), () => 'F'),
    );
    expect(saved).toBe('Saved: safety stricter night limit from false to true, safety heat index cap from 90 °F (32.2 C) to 86 °F (30 C).');
  });

  it('set_preferences refuses in °F with the °C to send in brackets (#306 review)', async () => {
    const refused = await session(createMemoryBacking(), (client) => client.callTool({ name: 'set_preferences', arguments: { comfortC: { cooling: 29 }, confirmed: true } }), () => 'F');
    expect(text(refused)).toContain('comfortC.cooling must stay within the safety threshold (80.6 °F (27 C)).');
  });

  it('#312: a heating comfort of 68 (°F, not converted) is refused with the 20 °C to send, and nothing is saved', async () => {
    const backing = createMemoryBacking();
    const refused = await session(backing, (client) => client.callTool({ name: 'set_preferences', arguments: { comfortC: { heating: 68 }, confirmed: true } }), () => 'F');
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(text(refused)).toContain('68 °F is 20 °C: send comfortC.heating 20.');
    const read = text(await session(backing, (client) => client.callTool({ name: 'get_preferences', arguments: {} }), () => 'F'));
    expect(read).not.toContain('154.4');
    const saved = text(await session(backing, (client) => client.callTool({ name: 'set_preferences', arguments: { comfortC: { heating: 19 }, confirmed: true } }), () => 'F'));
    expect(saved).toBe('Saved: comfort heating from 68 °F (20 C) to 66.2 °F (19 C).');
  });
});
