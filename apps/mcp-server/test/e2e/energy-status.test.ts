import { HomeStatusSchema } from '@cold-reserve/contracts';
import { fixedClock } from '@cold-reserve/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { startNodeServer, type RunningServer } from '../../src/node-server.js';
import { HOME_TOKEN, TOKEN } from '../helpers.js';

// get_home_status end to end: the official SDK client over real HTTP, the production registry and
// the seeded simulator (clear-day). Transport cases live in sdk-client.test.ts.
const STRANGER = 'n'.repeat(32);
let server: RunningServer;

beforeAll(async () => {
  const app = createApp(
    { MCP_CLIENTS: `agent@demo=${TOKEN},video@home=${HOME_TOKEN},stranger@nowhere=${STRANGER}`, MCP_SCENARIO_START_H: '14' },
    { wallClock: fixedClock(Date.UTC(2026, 8, 29, 7)), logger: { log: () => undefined } },
  );
  if (!app.ok) throw new Error(app.error.message);
  server = await startNodeServer(app.value.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: app.value.config.maxBodyBytes });
});
afterAll(async () => {
  await server.close();
});

async function callStatus(token: string) {
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  // SDK v1 types do not satisfy exactOptionalPropertyTypes (sessionId?: string vs undefined).
  await client.connect(transport as unknown as Transport);
  await client.listTools(); // loads the output validators, as a real agent would
  const result = await client.callTool({ name: 'get_home_status', arguments: {} });
  await client.close();
  return result;
}

describe('get_home_status through the SDK client', () => {
  it('demo home: structuredContent validated by the client, every group simulated', async () => {
    const result = await callStatus(TOKEN);
    expect(result.isError).toBeFalsy();
    const status = HomeStatusSchema.parse(result.structuredContent);
    expect(status).toMatchObject({ homeId: 'demo', homeLink: 'ok', origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated' } });
  });

  it('real home: served through the fallback, declared as lost, manual control only', async () => {
    const result = await callStatus(HOME_TOKEN);
    expect(result.structuredContent).toMatchObject({ homeId: 'home', homeLink: 'lost', controlAvailability: 'manual_only' });
  });

  it('home not configured: isError + home_not_found, not rejected by the client', async () => {
    const result = await callStatus(STRANGER);
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'home_not_found', retryable: false } });
  });
});
