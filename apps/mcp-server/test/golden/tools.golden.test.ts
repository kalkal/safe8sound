import { GetMilestonesOutputSchema, HOME_HEADER, LocationIdSchema, ScenarioIdSchema } from '@cold-reserve/contracts';
import { memoryLogger } from '@cold-reserve/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApp } from '../../src/local-app.js';
import { startNodeServer } from '../../src/node-server.js';
import { settableClock } from '../comfort-plan/support.js';
import { TOKEN } from '../helpers.js';

// Golden (C0, 18 Oct): what the tools of a visitor's sandbox return today, the structured content and the text the
// model reads, for each scenario in each place, at the day's start and at each moment its clock can jump to. Exactly
// as today, before scenarios and places move to one catalog. Never regenerated in a migration PR (`-u`).
// Local entry as deployed (infra/cdk.json): the daily anchor at real speed, on a fixed wall clock.

/** Plan ids are random per run: the golden keeps their place, not their value. */
const json = (value: unknown) => `${JSON.stringify(value, null, 2).replace(/\bplan_[A-Za-z0-9_-]{20}\b/g, 'plan_<id>')}\n`;
/** 18 Oct 2026, 09:00 in Rome. */
const WALL = Date.parse('2026-10-18T07:00:00Z');
const HOME = 'demo#00000000000000c0';
const ENV = { MCP_CLIENTS: `agent@demo#*=${TOKEN}`, MCP_SCENARIO: 'clear-day', MCP_SCENARIO_ANCHOR: 'daily' };
/** The longest day lists four moments; one more jump shows what a day with none left says. */
const MAX_JUMPS = 5;
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function sandbox() {
  const local = createLocalApp(ENV, { wallClock: settableClock(WALL), logger: memoryLogger() });
  if (!local.ok) throw new Error(local.error.message);
  const { app } = local.value;
  const server = await startNodeServer(app.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: app.config.maxBodyBytes });
  cleanup.push(() => server.close());
  const client = new Client({ name: 'golden', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, [HOME_HEADER]: HOME } } }) as unknown as Transport);
  cleanup.push(() => client.close());
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: unknown };
    return { tool: name, args, isError: result.isError === true, text: result.content.map((c) => c.text ?? '').join('\n'), structuredContent: result.structuredContent ?? null };
  };
}

describe('golden: the tools of a sandbox through its day', () => {
  for (const scenarioId of ScenarioIdSchema.options) {
    for (const placeId of LocationIdSchema.options) {
      it(`${scenarioId} in ${placeId}`, async () => {
        const call = await sandbox();
        const calls = [
          await call('set_scenario', { scenarioId, locationId: placeId }),
          await call('get_demo_settings'),
          await call('get_home_status'),
          await call('get_safe_room_status'),
          await call('get_reserve_outlook'),
          await call('plan_comfort', { goal: 'cool' }),
          await call('get_preferences'),
          // A looser safety limit is refused (limits only get stricter), in the place's unit.
          await call('set_preferences', { safety: { cooling: { maxC: 35 } }, confirmed: true }),
        ];
        for (let jump = 0; jump < MAX_JUMPS; jump++) {
          const listed = await call('get_milestones');
          calls.push(listed);
          const next = listed.isError ? undefined : GetMilestonesOutputSchema.parse(listed.structuredContent).milestones[0];
          if (next === undefined) break;
          calls.push(
            await call('advance_clock', { kind: next.kind, at: next.at }),
            await call('get_home_status'),
            await call('get_safe_room_status'),
            // A plan asked at this moment: in a storm, with the grid down, after the power is back.
            await call('plan_comfort', { goal: 'cool' }),
          );
        }
        await expect(json(calls)).toMatchFileSnapshot(`./__golden__/tools.${scenarioId}.${placeId}.json`);
      });
    }
  }
});
