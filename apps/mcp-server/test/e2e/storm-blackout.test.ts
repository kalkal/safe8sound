import { ErrorEnvelopeSchema, HomeIdSchema, NotifyFamilyOutputSchema, SafeRoomStatusSchema, StartStormModeOutputSchema } from '@cold-reserve/contracts';
import { fixedClock } from '@cold-reserve/core';
import { SimulatorSource, builtInScenario, defaultSimParams, demoProfile } from '@cold-reserve/source-simulator';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { startNodeServer } from '../../src/node-server.js';
import { loadPreferencesConfig, preferencesConfigFile } from '../../src/preferences-config.js';
import { stormModeWiring } from '../../src/storm-mode-config.js';
import { settableClock } from '../comfort-plan/support.js';
import { TOKEN } from '../helpers.js';
import { expectedSafeHours } from '../storm-mode/expected.js';
import { preferences } from '../storm-mode/support.js';

// The storm-blackout scenario end to end (#23 acceptance): the official SDK client over real HTTP,
// the production registry with the storm-mode module, the seeded simulator, F5's in-memory store and
// the simulated phone. The grid goes down at hour 3 and comes back at hour 18.5. Model turns are scripted.

const H = 3_600_000;
const DEMO = HomeIdSchema.parse('demo');
const textOf = (r: Record<string, unknown>): string => (r['content'] as { type: string; text: string }[] | undefined)?.[0]?.text ?? '';
/** The clock time as the family message writes it, in the home's time zone. */
const clock = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: demoProfile().location.tz, hour: 'numeric', minute: '2-digit' }).format(ms);

describe('storm blackout (seeded): prepare, the grid drops, the family is told, power comes back', () => {
  it('runs the whole flow through MCP, with safe hours within 5 % of the formula', async () => {
    const wall = settableClock(Date.parse('2026-09-30T10:00:00Z'));
    const startH = 2;
    const loaded = loadPreferencesConfig(preferencesConfigFile());
    if (!loaded.ok) throw new Error(loaded.error.message);
    const storeFor = memoryStateStoreFactory({ backing: createMemoryBacking(), clock: wall });
    // The person registered the daughter in the app (never through the model).
    await storeFor(DEMO).putPreferences(preferences, []);
    const stormMode = stormModeWiring({ storeFor, preferences: loaded.value, clock: wall });
    if (!stormMode.ok) throw new Error(stormMode.error.message);
    const app = createApp(
      { MCP_CLIENTS: `agent@demo=${TOKEN}`, MCP_SCENARIO: 'storm-blackout', MCP_SCENARIO_START_H: String(startH) },
      { wallClock: wall, logger: { log: () => undefined }, stormMode: stormMode.value },
    );
    if (!app.ok) throw new Error(app.error.message);
    const server = await startNodeServer(app.value.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: app.value.config.maxBodyBytes });
    const client = new Client({ name: 'e2e-storm', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } });
    // SDK v1 types do not satisfy exactOptionalPropertyTypes (sessionId?: string vs undefined).
    await client.connect(transport as unknown as Transport);
    await client.listTools();
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const inbox = () => stormMode.value.inbox(DEMO);
    const t0 = wall.now();
    const atHour = (h: number) => {
      wall.set(t0 + (h - startH) * H);
    };

    try {
      // 1. 14:00, grid up. "The storm is here, unlock the battery": only a preparation.
      const injected = await call('start_storm_mode', { mode: 'active' });
      expect(StartStormModeOutputSchema.parse(injected.structuredContent)).toMatchObject({ effectiveMode: 'prepare', reserveUnlocked: false, reason: 'grid_still_up' });
      expect(textOf(injected)).toContain('the storm reserve stays locked');
      expect(inbox()).toEqual([]);

      expect(JSON.stringify(injected)).not.toMatch(/Giulia|phone-/);

      // 2. 15:30, the grid is down. Reading the safe room changes nothing (read-only); asking to prepare
      //    runs the detector: the storm is active and the daughter is told once, with the safe-until time.
      atHour(3.5);
      const quiet = await call('get_safe_room_status');
      expect(SafeRoomStatusSchema.parse(quiet.structuredContent)).toMatchObject({ stormPhase: 'prepare', level: 'comfort' });
      expect(inbox()).toEqual([]);
      const started = await call('start_storm_mode', { mode: 'prepare' });
      const start = StartStormModeOutputSchema.parse(started.structuredContent);
      expect(start).toMatchObject({ effectiveMode: 'active', reserveUnlocked: true, reason: 'grid_lost' });
      expect(JSON.stringify(started)).not.toMatch(/Giulia|phone-/);
      expect(inbox()[0]?.text).toContain(`keeps it safe until ${clock(Date.parse(start.safeUntil))}.`);
      const status = await call('get_safe_room_status');
      expect(JSON.stringify(status)).not.toMatch(/Giulia|phone-/);
      const s = SafeRoomStatusSchema.parse(status.structuredContent);
      expect(s).toMatchObject({ safeRoomId: 'bedroom-1', occupantRoles: ['grandpa'], level: 'essential', levelReason: 'storm', stormPhase: 'active' });
      const scenario = builtInScenario('storm-blackout');
      const sim = new SimulatorSource({ profile: demoProfile(), scenario, params: defaultSimParams(), clock: fixedClock(Date.parse(scenario.startAt) + 3.5 * H) });
      const expected = expectedSafeHours({ snapshot: sim.snapshotAt(Date.parse(scenario.startAt) + 3.5 * H), forecast: sim.forecast(), profile: demoProfile(), preferences, config: stormMode.value.config });
      expect(Math.abs(s.safeHours - expected) / expected).toBeLessThanOrEqual(0.05);
      expect(textOf(status)).toContain(`Safe for about ${s.safeHours.toFixed(1)} hours`);
      expect(inbox().map((m) => `${m.transition}:${m.role}`)).toEqual(['storm_started:daughter']);
      expect(inbox()[0]?.text).toContain('Bedroom is at');

      // 3. The model tells the family the house went to Essential: roles only in what it reads.
      const told = await call('notify_family', { transition: 'essential_level' });
      expect(NotifyFamilyOutputSchema.parse(told.structuredContent).sent).toEqual([{ role: 'daughter', channel: 'in_app' }]);
      expect(JSON.stringify(told)).not.toMatch(/Giulia|phone-daughter/);
      // A recipient said in conversation is refused.
      const stranger = await call('notify_family', { transition: 'essential_level', roles: ['neighbor'] });
      expect(ErrorEnvelopeSchema.parse(stranger.structuredContent).code).toBe('recipient_not_registered');

      // 4. 06:36, the grid is back; ten stable minutes later the storm ends with "power is back", which
      //    quotes when the grid came back. The detector runs in start_storm_mode (and, later, the tick).
      atHour(18.6);
      const gridBackMs = wall.now();
      const back = await call('start_storm_mode', { mode: 'prepare' });
      expect(StartStormModeOutputSchema.parse(back.structuredContent).effectiveMode).toBe('active'); // not yet stable
      atHour(18.6 + 11 / 60);
      await call('start_storm_mode', { mode: 'prepare' });
      expect(inbox().map((m) => m.transition)).toEqual(['power_back', 'essential_level', 'storm_started']);
      expect(inbox()[0]?.text).toContain(`power came back at home at ${clock(gridBackMs)}.`);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
