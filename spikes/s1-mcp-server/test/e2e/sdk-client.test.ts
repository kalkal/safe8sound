import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startNodeServer, type RunningServer } from '../../src/node-server.js';
import { TOKEN, makeHandler } from '../helpers.js';

// End-to-end over real HTTP with the official TypeScript SDK client (the same client
// family Strands uses): initialize, tools/list, tools/call success and tool errors.
let server: RunningServer;

beforeAll(async () => {
  server = await startNodeServer(makeHandler().handler, { host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await server.close();
});

async function connect(token = TOKEN) {
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  // SDK v1 types do not satisfy exactOptionalPropertyTypes (sessionId?: string vs undefined).
  await client.connect(transport as unknown as Transport);
  return client;
}

describe('SDK client over HTTP', () => {
  it('negotiates 2025-11-25 and gets no session id', async () => {
    const client = await connect();
    const transport = client.transport as StreamableHTTPClientTransport;
    expect(transport.sessionId).toBeUndefined();
    expect(transport.protocolVersion).toBe('2025-11-25');
    await client.close();
  });

  it('lists tools and calls one successfully (structuredContent validated by the client)', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('get_reserve_status');
    const result = await client.callTool({ name: 'get_reserve_status', arguments: { homeId: 'home-demo' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ homeId: 'home-demo', stateOfChargePct: 62 });
    await client.close();
  });

  it('receives a tool error as isError + structuredContent without the client rejecting it', async () => {
    const client = await connect();
    await client.listTools(); // loads the output validators, as a real agent would
    const result = await client.callTool({ name: 'get_reserve_status', arguments: { homeId: 'home-stale' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'home_data_stale', retryable: true });
    await client.close();
  });

  it('gets a JSON-RPC error for an unknown tool', async () => {
    const client = await connect();
    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toMatchObject({ code: -32602 });
    await client.close();
  });

  it('fails to connect with a wrong token (401)', async () => {
    await expect(connect('x'.repeat(32))).rejects.toThrow(/401|Unauthorized|invalid_token/i);
  });
});

describe('raw HTTP against the running server', () => {
  it('GET -> 405', async () => {
    const res = await fetch(server.url, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
  });

  it('foreign Origin -> 403', async () => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });
});
