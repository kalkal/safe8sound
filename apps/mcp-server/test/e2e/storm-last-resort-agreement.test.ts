import { PlanSchema, SafeRoomStatusSchema, type Plan, type SafeRoomStatus } from '@cold-reserve/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createLocalApp } from '../../src/local-app.js';
import { startNodeServer } from '../../src/node-server.js';
import { settableClock } from '../comfort-plan/support.js';
import { TOKEN } from '../helpers.js';

// One physics for "safe until" (Q7-A of #24): the storm card reads the guard's hold of the safe room
// (holdSafeRoom), pre-cooled toward the night limit; the last-resort plan reads the same engine and limits.
// The battery level is set at the scenario start (hour 0): by hour 8, 30 % has become 16 %.

// Mutation testing runs the properties with fewer cases (FC_RUNS); CI and local runs use the full count.
const runs = (n: number): number => Number(process.env['FC_RUNS'] ?? n);

/** The storm card and a plan_comfort answer at a scenario start hour and start battery level, on the local entry. */
async function at(startH: number, startSocPct: number): Promise<{ status: SafeRoomStatus; plan: Plan }> {
  const wall = settableClock(Date.parse('2026-10-03T10:00:00Z'));
  const env = { MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_SCENARIO: 'storm-blackout', MCP_SCENARIO_START_H: String(startH), MCP_SCENARIO_START_SOC_PCT: String(startSocPct) };
  const local = createLocalApp(env, { wallClock: wall, logger: { log: () => undefined } });
  if (!local.ok) throw new Error(local.error.message);
  const server = await startNodeServer(local.value.app.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: local.value.app.config.maxBodyBytes });
  const client = new Client({ name: 'e2e-agreement', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }) as unknown as Transport);
  try {
    const status = SafeRoomStatusSchema.parse((await client.callTool({ name: 'get_safe_room_status', arguments: {} })).structuredContent);
    const plan = PlanSchema.parse((await client.callTool({ name: 'plan_comfort', arguments: { goal: 'cool' } })).structuredContent);
    return { status, plan };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('the storm card and the last-resort plan on one physics', () => {
  it('hour 4, 22 % at the start, grandpa: both name the battery at 03:05, and the room holds 24 °C until about 06:00', async () => {
    const { status, plan } = await at(4, 22);
    expect(status.occupantRoles).toContain('grandpa');
    // Pre-cooled toward the 24 °C night limit, the room is inside it all evening: the battery ends the safe hours,
    // never the night limit at 22:00, and the room then holds 24 °C a while by inertia.
    expect(plan.lastResort?.limitedBy).toBe('battery');
    expect(status.safeUntil).toBe(plan.lastResort?.safeUntil);
    expect(status.safeUntil).toBe('2026-07-18T03:05:00+02:00');
    expect(plan.lastResort?.limitCrossedAt).toBe('2026-07-18T06:00:00+02:00');
  });

  it('hour 4, 50 %: a plan keeps him safe (no last resort), and the storm card does not stop at 22:00', async () => {
    const { status, plan } = await at(4, 50);
    expect(plan.lastResort).toBeUndefined();
    expect(plan.guarantees.every((g) => g.ok)).toBe(true);
    // Pre-cooled toward the 24 °C night limit, the battery holds the safe room through the 24-hour cap.
    expect(status.safeHours).toBe(24);
  });

  it.each([
    [4, 20, '2026-07-18T01:30:00+02:00'],
    [6, 20, '2026-07-17T20:05:00+02:00'],
    [6, 30, '2026-07-18T03:55:00+02:00'],
    [8, 30, '2026-07-17T22:20:00+02:00'],
  ])('hour %i with %i percent at the start: the last resort is the hold, both name %s (#24, decision A)', async (h, soc, until) => {
    const { status, plan } = await at(h, soc);
    expect(plan.lastResort).toBeDefined();
    // Pinned as times, not only equal: a regression of the hold would move both together.
    expect(status.safeUntil).toBe(until);
    expect(plan.lastResort?.safeUntil).toBe(until);
    expect(status.safeHours).toBe(plan.lastResort?.safeHours);
  });

  it('hour 6, 20 %: both run out of battery before 22:00, at the same time (the energy side)', async () => {
    const { status, plan } = await at(6, 20);
    expect(plan.lastResort?.limitedBy).toBe('battery');
    expect(status.safeUntil).toBe('2026-07-17T20:05:00+02:00');
    // Cooled to the comfort setpoint while there is energy, the room then holds its limit until 22:15.
    expect(plan.lastResort?.limitCrossedAt).toBe('2026-07-17T22:15:00+02:00');
    expect(status.safeUntil).toBe(plan.lastResort?.safeUntil);
  });

  it('property: whatever the battery and the hour, a last resort and a storm card under its cap name the same time', async () => {
    let checked = 0;
    await fc.assert(
      // Low batteries, where a last resort exists: most cases really compare the two times.
      fc.asyncProperty(fc.integer({ min: 3, max: 10 }), fc.integer({ min: 12, max: 30 }), async (h, soc) => {
        const { status, plan } = await at(h, soc);
        if (plan.lastResort === undefined || status.safeHours >= 24) return;
        checked++;
        expect(status.safeUntil).toBe(plan.lastResort.safeUntil);
      }),
      // Each case starts a local server and plans a storm night (about a second).
      { numRuns: runs(20) },
    );
    // A property that skips every case proves nothing (#182 re-review).
    expect(checked).toBeGreaterThanOrEqual(Math.ceil(runs(20) / 2));
  }, 300_000);

  it('property: at the same hour, more battery never brings the room out of its limits earlier (#332 review)', async () => {
    /** When the plan says the room leaves its limits: the end of the safe hours on the room, or the crossing after the battery. */
    const outOfLimits = (plan: Plan): number => {
      const lr = plan.lastResort;
      if (lr === undefined) return Number.POSITIVE_INFINITY;
      if (lr.limitedBy !== 'battery') return Date.parse(lr.safeUntil);
      return lr.limitCrossedAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(lr.limitCrossedAt);
    };
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 3, max: 8 }), async (h) => {
        let previous = Number.NEGATIVE_INFINITY;
        for (let soc = 12; soc <= 30; soc += 3) {
          const { status, plan } = await at(h, soc);
          if (plan.lastResort !== undefined && status.safeHours < 24) expect(status.safeUntil).toBe(plan.lastResort.safeUntil);
          const out = outOfLimits(plan);
          expect(out, `hour ${String(h)}, ${String(soc)} %`).toBeGreaterThanOrEqual(previous);
          previous = out;
        }
      }),
      // Seven local servers per case (about a second each).
      { numRuns: runs(3) },
    );
  }, 300_000);
});
