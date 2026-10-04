import { HomeStatusSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { createApp, scenarioAnchor } from '../src/app.js';
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
  it('daily: refuses a place without a valid IANA zone with invalid_config (L1, #217)', () => {
    expect(scenarioAnchor('daily', 0, 'Mars/Olympus')).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(scenarioAnchor('daily', 0, 'Europe/Rome').ok).toBe(true);
  });

  it('daily: two containers started hours apart give the same time and battery', async () => {
    const a = instance({ MCP_SCENARIO_ANCHOR: 'daily' }, at('2026-10-01T07:00:00Z'));
    const b = instance({ MCP_SCENARIO_ANCHOR: 'daily' }, at('2026-10-01T11:00:00Z'));
    a.wall.set(at('2026-10-01T12:00:00Z'));
    b.wall.set(at('2026-10-01T12:00:00Z'));
    const [sa, sb] = [await a.status(), await b.status()];
    expect(sb.ts).toBe(sa.ts);
    expect(sb.batterySocPct).toBe(sa.batterySocPct);
  });

  it('daily: the scenario day starts at midnight in the IANA zone of the place, also in winter (T1)', async () => {
    // In December Rome is on +01:00: its midnight is 23:00 UTC, not 22:00 UTC as the scenario's fixed +02:00 said.
    const a = instance({ MCP_SCENARIO_ANCHOR: 'daily' }, at('2026-12-01T23:30:00Z'));
    expect((await a.status()).ts).toBe(new Date(at('2026-07-16T00:30:00+02:00')).toISOString());
    // Two containers started on either side of Rome's midnight, read at the same instant, agree.
    const b = instance({ MCP_SCENARIO_ANCHOR: 'daily' }, at('2026-12-01T22:30:00Z'));
    b.wall.set(at('2026-12-01T23:30:00Z'));
    expect((await b.status()).ts).toBe((await a.status()).ts);
  });

  it('daily: the scenario day starts at local midnight of the scenario (its +02:00), not at UTC midnight', async () => {
    // heatwave starts at 2026-07-16T00:00:00+02:00; at 12:00 in Rome the scenario shows 12:00 too.
    const a = instance({ MCP_SCENARIO_ANCHOR: 'daily' }, at('2026-10-01T10:00:00Z'));
    expect((await a.status()).ts).toBe(new Date(at('2026-07-16T12:00:00+02:00')).toISOString());
    // 01:00 in Rome is still the scenario day that began at Rome midnight (23:00 UTC the day before).
    a.wall.set(at('2026-09-30T23:00:00Z'));
    expect((await a.status()).ts).toBe(new Date(at('2026-07-16T01:00:00+02:00')).toISOString());
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
