import { HomeStatusSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { settableClock } from './comfort-plan/support.js';
import { TOKEN, callTool, post, toolResult } from './helpers.js';

// R1 (architecture check of 2026-10-01): two warm Lambdas must tell the same story. With
// MCP_SCENARIO_ANCHOR the scenario time is a function of the wall time only, not of when the container started.

const H = 3_600_000;
const at = (iso: string) => Date.parse(iso);

function instance(env: Record<string, string>, startedAt: number) {
  const wall = settableClock(startedAt);
  const app = createApp({ MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_SCENARIO: 'heatwave', ...env }, { wallClock: wall, logger: { log: () => undefined } });
  if (!app.ok) throw new Error(app.error.message);
  const status = async () => HomeStatusSchema.parse((await toolResult(await post(app.value.handler, callTool('get_home_status', {})))).structuredContent);
  return { wall, status };
}

describe('scenario anchor (MCP_SCENARIO_ANCHOR)', () => {
  it('daily: two containers started hours apart give the same time and battery', async () => {
    const a = instance({ MCP_SCENARIO_ANCHOR: 'daily' }, at('2026-10-01T07:00:00Z'));
    const b = instance({ MCP_SCENARIO_ANCHOR: 'daily' }, at('2026-10-01T11:00:00Z'));
    a.wall.set(at('2026-10-01T12:00:00Z'));
    b.wall.set(at('2026-10-01T12:00:00Z'));
    const [sa, sb] = [await a.status(), await b.status()];
    expect(sb.ts).toBe(sa.ts);
    expect(sb.batterySocPct).toBe(sa.batterySocPct);
  });

  it('a fixed instant: the scenario starts at that wall time, whatever the container start', async () => {
    const a = instance({ MCP_SCENARIO_ANCHOR: '2026-10-01T10:00:00Z', MCP_SCENARIO_START_H: '14' }, at('2026-10-01T12:00:00Z'));
    const scenarioStart = Date.parse((await instance({ MCP_SCENARIO_START_H: '14' }, at('2026-10-01T12:00:00Z')).status()).ts);
    expect(Date.parse((await a.status()).ts)).toBe(scenarioStart + 2 * H);
  });

  it('start (the default, for local runs): the scenario starts when the server starts', async () => {
    const a = instance({}, at('2026-10-01T07:00:00Z'));
    const b = instance({}, at('2026-10-01T11:00:00Z'));
    a.wall.set(at('2026-10-01T12:00:00Z'));
    b.wall.set(at('2026-10-01T12:00:00Z'));
    expect(Date.parse((await a.status()).ts) - Date.parse((await b.status()).ts)).toBe(4 * H);
  });

  it('refuses any other value with invalid_config', () => {
    const app = createApp({ MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_SCENARIO_ANCHOR: 'tomorrow' }, { wallClock: settableClock(0), logger: { log: () => undefined } });
    expect(app).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});
