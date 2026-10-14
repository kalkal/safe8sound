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
// The battery level is set at the scenario start (hour 0). Since #390 the storm script holds the safe room with a cool
// split (25 °C, then the 24 °C night limit from 21:00), so the charge barely moves before the evening.

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
  it('hour 5, 14 % at the start, grandpa: both name the battery at 23:25, and the room holds 24 °C until about 02:00', async () => {
    const { status, plan } = await at(5, 14);
    expect(status.occupantRoles).toContain('grandpa');
    // Pre-cooled toward the 24 °C night limit, the room is inside it all evening: the battery ends the safe hours,
    // never the night limit at 22:00, and the room then holds 24 °C a while by inertia.
    expect(plan.lastResort?.limitedBy).toBe('battery');
    expect(status.safeUntil).toBe(plan.lastResort?.safeUntil);
    expect(status.safeUntil).toBe('2026-07-17T23:25:00+02:00');
    expect(plan.lastResort?.limitCrossedAt).toBe('2026-07-18T02:00:00+02:00');
    // #364: the storm card's big time is the same room time, the battery time below it.
    expect(status.withinLimits).toEqual({ until: '2026-07-18T02:00:00+02:00', limitC: plan.lastResort?.limitCrossedC });
  });

  it('hour 4, 50 %: a plan keeps him safe (no last resort), and the storm card does not stop at 22:00', async () => {
    const { status, plan } = await at(4, 50);
    expect(plan.lastResort).toBeUndefined();
    expect(plan.guarantees.every((g) => g.ok)).toBe(true);
    // Pre-cooled toward the 24 °C night limit, the battery holds the safe room through the 24-hour cap.
    expect(status.safeHours).toBe(24);
  });

  it.each([
    [3, 10, '2026-07-17T21:45:00+02:00'],
    [5, 18, '2026-07-18T02:35:00+02:00'],
    [7, 14, '2026-07-17T23:25:00+02:00'],
    [9, 22, '2026-07-18T05:55:00+02:00'],
  ])('hour %i with %i percent at the start: the last resort is the hold, both name %s (#24, decision A)', async (h, soc, until) => {
    const { status, plan } = await at(h, soc);
    expect(plan.lastResort).toBeDefined();
    // Pinned as times, not only equal: a regression of the hold would move both together.
    expect(status.safeUntil).toBe(until);
    expect(plan.lastResort?.safeUntil).toBe(until);
    expect(status.safeHours).toBe(plan.lastResort?.safeHours);
  });

  it('hour 7, 10 %: both run out of battery before 22:00, at the same time (the energy side)', async () => {
    const { status, plan } = await at(7, 10);
    expect(status.withinLimits?.until).toBe(plan.lastResort?.limitCrossedAt);
    expect(plan.lastResort?.limitedBy).toBe('battery');
    expect(status.safeUntil).toBe('2026-07-17T21:40:00+02:00');
    // The room then holds its limit by inertia until midnight.
    expect(plan.lastResort?.limitCrossedAt).toBe('2026-07-18T00:00:00+02:00');
    expect(status.safeUntil).toBe(plan.lastResort?.safeUntil);
  });

  it('property: whatever the battery and the hour, a last resort and a storm card under its cap name the same time', async () => {
    let checked = 0;
    await fc.assert(
      // Low batteries, where a last resort exists: most cases really compare the two times. Up to 21:00 (hour 9): from
      // 22:00 the script has the room at the night limit, so a low battery is a refusal of the pace, never a last resort.
      fc.asyncProperty(fc.integer({ min: 3, max: 9 }), fc.integer({ min: 10, max: 24 }), async (h, soc) => {
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

  it('property: at the same hour, more battery never brings the big time on either card earlier (#332 review, #364)', async () => {
    /**
     * The big time on the plan card (#364, ui-cards lastResortHeadline): the crossing after the battery, the next
     * recharge when the room holds its limits that long, else the end of the safe hours; a plan that holds, its horizon.
     */
    const outOfLimits = (plan: Plan): number => {
      const lr = plan.lastResort;
      if (lr === undefined) return Date.parse(plan.horizonAt);
      if (lr.limitedBy !== 'battery') return Date.parse(lr.safeUntil);
      if (lr.limitCrossedAt !== undefined) return Date.parse(lr.limitCrossedAt);
      return Date.parse(lr.worstAt === undefined ? plan.horizonAt : lr.safeUntil);
    };
    /** The big time on the storm card (#364): the room's when the battery runs out first, else the end of the safe hours. */
    const storm = (status: SafeRoomStatus): number => Date.parse(status.withinLimits?.until ?? status.safeUntil);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 3, max: 8 }), async (h) => {
        let previousStorm = Number.NEGATIVE_INFINITY;
        let previous = Number.NEGATIVE_INFINITY;
        for (let soc = 12; soc <= 30; soc += 3) {
          const { status, plan } = await at(h, soc);
          if (plan.lastResort !== undefined && status.safeHours < 24) expect(status.safeUntil).toBe(plan.lastResort.safeUntil);
          const out = outOfLimits(plan);
          expect(out, `hour ${String(h)}, ${String(soc)} %`).toBeGreaterThanOrEqual(previous);
          previous = out;
          const card = storm(status);
          expect(card, `storm card, hour ${String(h)}, ${String(soc)} %`).toBeGreaterThanOrEqual(previousStorm);
          previousStorm = card;
        }
      }),
      // Seven local servers per case (about a second each).
      { numRuns: runs(3) },
    );
  }, 300_000);
});
