import { PlanSchema } from '@cold-reserve/contracts';
import { memoryLogger } from '@cold-reserve/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { createLocalApp } from '../../src/local-app.js';
import { startNodeServer } from '../../src/node-server.js';
import { settableClock } from '../comfort-plan/support.js';
import { TOKEN } from '../helpers.js';

// #266: the heat-safety settings over MCP, on the local entry (every module, the in-memory store). The heatwave at
// 23:00 with grandpa in the safe room: a proposal that holds the room at 25 °C all night.
// - Off (the default): the night is judged by the night-recovery target, hours at or below 24 °C.
// - On: every point of the night window is held to the 24 °C night limit, like the last resort.

const WALL = Date.parse('2026-10-05T10:00:00Z');

async function proposeAt25(stricterNightLimit: boolean) {
  const local = createLocalApp({ MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_SCENARIO: 'heatwave', MCP_SCENARIO_START_H: '23' }, { wallClock: settableClock(WALL), logger: memoryLogger() });
  if (!local.ok) throw new Error(local.error.message);
  const server = await startNodeServer(local.value.app.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: local.value.app.config.maxBodyBytes });
  const client = new Client({ name: 'e2e-heat-safety', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }) as unknown as Transport);
  try {
    const set = await client.callTool({ name: 'set_preferences', arguments: { safety: { stricterNightLimit }, confirmed: true } });
    expect(set.isError).toBeFalsy();
    const r = await client.callTool({ name: 'plan_comfort', arguments: { goal: 'cool', setpointC: 25, roomIds: ['bedroom-1'] } });
    expect(r.isError).toBeFalsy();
    return PlanSchema.parse(r.structuredContent);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('the stricter night limit over MCP (#266)', () => {
  it('off: the 25 °C night is refused on the night-recovery hours; the plan that holds answers', async () => {
    const plan = await proposeAt25(false);
    expect(plan.refusedProposal).toMatchObject({ code: 'night_recovery_unmet' });
    expect(plan.guarantees.every((g) => g.ok)).toBe(true);
  });

  it('on: every point of the night is held to 24 °C, and the refusal says so', async () => {
    const plan = await proposeAt25(true);
    expect(plan.refusedProposal).toEqual({ code: 'safe_room_comfort_violated', message: 'The safe room would reach 25 °C, above its 24 °C maximum. Nearest allowed: 24 C.' });
    expect(plan.guarantees.every((g) => g.ok)).toBe(true);
  });
});
