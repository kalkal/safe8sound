import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { startNodeServer, type RunningServer } from '../../src/node-server.js';
import { HOME_TOKEN, TOKEN, probeModule } from '../helpers.js';

// End-to-end over real HTTP with the official TypeScript SDK client (the client family Strands
// uses): the composition root, the Node entry and a test capability module.
let server: RunningServer;

beforeAll(async () => {
  const app = createApp(
    { MCP_CLIENTS: `agent@demo=${TOKEN},video@home=${HOME_TOKEN}` },
    { logger: { log: () => undefined }, modules: [probeModule] },
  );
  if (!app.ok) throw new Error(app.error.message);
  server = await startNodeServer(app.value.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: app.value.config.maxBodyBytes });
});
afterAll(async () => {
  await server.close();
});

async function connect(token = TOKEN) {
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  // SDK v1 types do not satisfy exactOptionalPropertyTypes (sessionId?: string vs undefined).
  await client.connect(transport as unknown as Transport);
  return { client, transport };
}

describe('SDK client over HTTP', () => {
  it('initializes on 2025-11-25 without a session id', async () => {
    const { client, transport } = await connect();
    expect(transport.sessionId).toBeUndefined();
    expect(transport.protocolVersion).toBe('2025-11-25');
    await client.close();
  });

  it('lists the module tools with their annotations and calls one: the home comes from the token', async () => {
    const { client } = await connect(HOME_TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['whoami', 'explode', 'bad_output']);
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.structuredContent).toEqual({ clientId: 'video', homeId: 'home' });
    await client.close();
  });

  it('receives tool errors as isError + structuredContent without the client rejecting them', async () => {
    const { client } = await connect();
    await client.listTools(); // loads the output validators, as a real agent would
    const invalid = await client.callTool({ name: 'whoami', arguments: { homeId: 'home' } });
    expect(invalid).toMatchObject({ isError: true, structuredContent: { code: 'invalid_input' } });
    const thrown = await client.callTool({ name: 'explode', arguments: {} });
    expect(thrown).toMatchObject({ isError: true, structuredContent: { code: 'unexpected_error' } });
    await client.close();
  });

  it('gets a JSON-RPC error for an unknown tool', async () => {
    const { client } = await connect();
    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toMatchObject({ code: -32602 });
    await client.close();
  });

  it('cannot connect with a token nobody was issued (401)', async () => {
    await expect(connect('x'.repeat(32))).rejects.toThrow(/401|Unauthorized|wrong_client/i);
  });
});

describe('raw HTTP against the running server', () => {
  it('GET -> 405, foreign Origin -> 403, unknown path -> 404', async () => {
    expect((await fetch(server.url, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
    const evil = await fetch(server.url, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(evil.status).toBe(403);
    expect((await fetch(server.url.replace('/mcp', '/other'), { method: 'POST', body: '{}' })).status).toBe(404);
  });
});

describe('createApp', () => {
  it('fails with invalid_config on a bad token list or a bad module set', () => {
    const log = { log: () => undefined };
    expect(createApp({}, { logger: log })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(createApp({ MCP_CLIENTS: `agent@demo=${TOKEN}` }, { logger: log, modules: [probeModule, probeModule] })).toMatchObject({
      ok: false,
      error: { code: 'invalid_config' },
    });
  });
});
