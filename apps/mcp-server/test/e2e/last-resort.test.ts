import { ApplyPlanOutputSchema, ErrorEnvelopeSchema, HomeIdSchema, PlanSchema, ok, pct } from '@cold-reserve/contracts';
import { fixedClock } from '@cold-reserve/core';
import { SimulatorSource, builtInScenario, defaultSimParams, demoProfile } from '@cold-reserve/source-simulator';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { comfortPlanWiring } from '../../src/comfort-plan-config.js';
import { startNodeServer } from '../../src/node-server.js';
import { loadPreferencesConfig, preferencesConfigFile } from '../../src/preferences-config.js';
import { stormModeWiring } from '../../src/storm-mode-config.js';
import { localTimeText } from '@cold-reserve/core';
import { settableClock } from '../comfort-plan/support.js';
import { TOKEN } from '../helpers.js';
import { preferences } from '../storm-mode/support.js';

// The last-resort plan end to end (#160 acceptance): the storm-blackout scenario with the battery at 20 % and
// grandpa in the safe room, the official SDK client over real HTTP, the production registry, F5's in-memory
// store and the simulated phone. No plan keeps the room under the 24 °C night limit: plan_comfort proposes the
// safest one with its honest window and the zero-energy actions; a plain apply_plan only returns a token; the
// second yes with that token applies it and the daughter gets the fixed alert.

const H = 3_600_000;
const DEMO = HomeIdSchema.parse('demo');
const textOf = (r: Record<string, unknown>): string => (r['content'] as { type: string; text: string }[] | undefined)?.[0]?.text ?? '';
const clock = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: demoProfile().location.tz, hour: 'numeric', minute: '2-digit' }).format(Date.parse(iso));
/** #390: the family reads a time on the day after the storm afternoon (17 July) as tomorrow's. */
const said = (iso: string) => clock(iso) + (iso.slice(0, 10) > '2026-07-17' ? ' tomorrow' : '');

describe('storm, battery 20 %: the last resort, confirmed twice, tells the family', () => {
  it('runs through MCP: window, actions, two yeses, the alert, and a model plan past the physical limits still refused', async () => {
    const wall = settableClock(Date.parse('2026-09-30T10:00:00Z'));
    const startH = 3;
    const loaded = loadPreferencesConfig(preferencesConfigFile());
    if (!loaded.ok) throw new Error(loaded.error.message);
    const storeFor = memoryStateStoreFactory({ backing: createMemoryBacking(), clock: wall });
    await storeFor(DEMO).putPreferences(preferences, []);
    const stormMode = stormModeWiring({ storeFor, preferences: loaded.value, clock: wall });
    if (!stormMode.ok) throw new Error(stormMode.error.message);
    const comfortPlan = comfortPlanWiring({ storeFor, preferences: loaded.value, clock: wall, notifier: stormMode.value.notifier });
    if (!comfortPlan.ok) throw new Error(comfortPlan.error.message);
    // The same seeded simulator as the app, with the battery at 20 %.
    const scenario = builtInScenario('storm-blackout');
    const t0 = wall.now();
    const sim = new SimulatorSource({ profile: demoProfile(), scenario, params: defaultSimParams(), clock: fixedClock(Date.parse(scenario.startAt)) });
    const source = {
      snapshot: () => {
        const at = Date.parse(scenario.startAt) + startH * H + (wall.now() - t0);
        return Promise.resolve(ok({ ...sim.snapshotAt(at), batterySocPct: pct(20) }));
      },
    };
    const app = createApp(
      { MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_SCENARIO: 'storm-blackout', MCP_SCENARIO_START_H: String(startH) },
      { wallClock: wall, logger: { log: () => undefined }, comfortPlan: comfortPlan.value, stormMode: stormMode.value, sourceOverride: () => source },
    );
    if (!app.ok) throw new Error(app.error.message);
    const server = await startNodeServer(app.value.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: app.value.config.maxBodyBytes });
    const client = new Client({ name: 'e2e-last-resort', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } });
    await client.connect(transport as unknown as Transport);
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const inbox = async () => {
      const listed = await stormMode.value.inbox(DEMO);
      if (!listed.ok) throw new Error(listed.error.message);
      return listed.value;
    };

    try {
      // 1. "Keep grandpa cool": no plan holds the night, so the safest one, with every number said.
      const planned = await call('plan_comfort', { goal: 'cool' });
      const plan = PlanSchema.parse(planned.structuredContent);
      const lr = plan.lastResort;
      if (lr?.worstC === undefined || lr.worstAt === undefined) throw new Error('no last resort with a window');
      // The last resort is the hold (#24, decision A): pre-cooled, the room is inside 24 °C when the night starts.
      expect(lr.loweredLimitC).toBeUndefined();
      expect(lr.actions).toEqual(['close_curtains', 'drink_water', 'fan_below_35c']);
      expect(plan.guarantees.filter((g) => ['storm_reserve', 'inverter_limit', 'battery_power'].includes(g.id)).every((g) => g.ok)).toBe(true);
      // The first sentence carries the honest window (CE-21).
      // #364: when the room holds its limit after the battery runs out, its time comes first, then the battery's.
      const head =
        lr.limitCrossedAt === undefined
          ? `(within its limits until|until the battery runs out at) ${localTimeText(lr.safeUntil)} `
          : `within its limits until about ${localTimeText(lr.limitCrossedAt)}, the battery until ${localTimeText(lr.safeUntil)} `;
      expect(textOf(planned)).toMatch(new RegExp(`^Proposed last-resort plan: the safe room alone, ${head}`));
      // #376: the card's advice, with the number to call at the home's place (the local entry is the reference home).
      expect(lr.place).toBe('reference');
      expect(textOf(planned)).toContain('If you are worried, call 112.');

      // 2. The first yes applies nothing: a token, the risk to read, and the alert announced.
      const first = await call('apply_plan', { planId: plan.id });
      const step1 = ApplyPlanOutputSchema.parse(first.structuredContent);
      expect(step1.plan.status).toBe('proposed');
      expect(textOf(first)).toMatch(/^Not applied yet: this is a last resort\./);
      expect(await inbox()).toEqual([]);
      const token = step1.confirmation?.token;
      if (token === undefined) throw new Error('no token');

      // 3. A wrong token is refused; the second yes with the right one applies it, and the daughter is told.
      const wrong = await call('apply_plan', { planId: plan.id, lastResortToken: `lr_${'x'.repeat(32)}` });
      expect(ErrorEnvelopeSchema.parse(wrong.structuredContent).code).toBe('last_resort_token_invalid');
      const second = await call('apply_plan', { planId: plan.id, lastResortToken: token });
      expect(ApplyPlanOutputSchema.parse(second.structuredContent)).toMatchObject({ plan: { status: 'applied' }, familyAlert: { sent: 1, failed: 0 } });
      expect(textOf(second)).toContain('1 registered family contact was alerted.');
      expect(textOf(first)).not.toContain('family');
      const messages = await inbox();
      expect(messages.map((m) => `${m.transition}:${m.role}`)).toEqual(['last_resort_applied:daughter']);
      // #364: the room's time first, the battery's after it, as on the card.
      expect(messages[0]?.text).toContain(
        lr.limitCrossedAt === undefined
          ? `until ${said(lr.safeUntil)}, then gets warmer. Please check on them.`
          : `stays within its limits until about ${said(lr.limitCrossedAt)} (battery until ${said(lr.safeUntil)}), then gets warmer. Please check on them.`,
      );
      expect(JSON.stringify(second)).not.toMatch(/(^|[^A-Za-z])Ana([^A-Za-z]|$)|phone-/);

      // 4. A plan the model proposes past the physical limits is still a refusal, never a last resort.
      const all = demoProfile().rooms.map((r) => r.id);
      const greedy = await call('plan_comfort', { goal: 'cool', setpointC: 18, roomIds: all });
      expect(greedy.isError).toBe(true);
      expect(ErrorEnvelopeSchema.parse(greedy.structuredContent).category).toBe('guard_rejection');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
