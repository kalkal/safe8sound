import { HomeIdSchema, SafeRoomStatusSchema, StartStormModeOutputSchema } from '@cold-reserve/contracts';
import { memoryLogger, seededRng } from '@cold-reserve/core';
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
import { preferences } from '../storm-mode/support.js';

// #234: on AWS the storm day replays every day (MCP_SCENARIO_ANCHOR=daily). Each replay is a playthrough of its own:
// yesterday's storm is not today's, and the family is told once per storm, never once per reading.

const DEMO = HomeIdSchema.parse('demo');
// 05:00 in Rome: the storm day reads 17:00 of 17 July, the grid is down (it fails at hour 3 of the script, 15:00).
const DAY_1 = Date.parse('2026-10-04T03:00:00Z');
const DAY_2 = DAY_1 + 24 * 3_600_000;

describe('a replayed storm day on the Lambda composition (#234)', () => {
  it('yesterday storm is not today: one storm_started per playthrough, none per reading', async () => {
    const wall = settableClock(DAY_1);
    const table = createFakeTable();
    const storeFor = dynamoStateStoreFactory({ table, clock: wall, rng: seededRng(5) });
    // The person registered the daughter in the app (never through the model).
    expect((await storeFor(DEMO).putPreferences(preferences, [])).ok).toBe(true);
    const lambda = createLambdaApp({ MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_SCENARIO: 'storm-blackout', MCP_SCENARIO_ANCHOR: 'daily' }, { wallClock: wall, logger: memoryLogger(), storeFor });
    if (!lambda.ok) throw new Error(lambda.error.message);
    const server = await startNodeServer(lambda.value.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: lambda.value.config.maxBodyBytes });
    const client = new Client({ name: 'e2e-replay', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }) as unknown as Transport);
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const room = async () => SafeRoomStatusSchema.parse((await call('get_safe_room_status')).structuredContent);
    const stormStarted = async () => (await table.query('HOME#demo', 'PLAY#')).filter((i) => i['SK'].includes('INBOX#') && (i['data'] as { transition?: string }).transition === 'storm_started').length;

    try {
      // Day 1: the grid is down, the person prepares, the detector starts the storm and tells the daughter once.
      expect(StartStormModeOutputSchema.parse((await call('start_storm_mode', { mode: 'prepare' })).structuredContent)).toMatchObject({ effectiveMode: 'active' });
      for (let i = 0; i < 3; i++) expect((await room()).stormPhase).toBe('active');
      expect(await stormStarted()).toBe(1);

      // Day 2, same hour: the day replays. Yesterday's storm is not there, and reading does not tell anyone.
      wall.set(DAY_2);
      expect((await room()).stormPhase).toBeUndefined();
      expect(await stormStarted()).toBe(1);
      expect(StartStormModeOutputSchema.parse((await call('start_storm_mode', { mode: 'prepare' })).structuredContent)).toMatchObject({ effectiveMode: 'active' });
      for (let i = 0; i < 3; i++) expect((await room()).stormPhase).toBe('active');
      expect(await stormStarted()).toBe(2);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
