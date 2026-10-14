import { GetMilestonesOutputSchema, HOME_HEADER, HomeIdSchema, SafeRoomStatusSchema, type GetMilestonesOutput } from '@cold-reserve/contracts';
import { memoryLogger } from '@cold-reserve/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApp } from '../../src/local-app.js';
import { startNodeServer } from '../../src/node-server.js';
import { settableClock } from '../comfort-plan/support.js';
import { TOKEN } from '../helpers.js';

// #390: the whole storm story of a visitor's sandbox, as the judges play it on the site with Skip ahead: the storm is
// forecast (the family hears it once), the grid goes down at 15:00, the night stops at the essential level (21:00),
// power comes back at 06:30 and the house is cooled again. Ana's phone gets one message per moment, each at its time,
// with times that never read as "now" and temperatures inside the safe room's limits, never "no action" above them.

const A = 'demo#00000000000000aa';
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function open() {
  const logger = memoryLogger();
  const local = createLocalApp({ MCP_CLIENTS: `agent@demo#*=${TOKEN}`, MCP_SCENARIO: 'storm-blackout' }, { wallClock: settableClock(Date.parse('2026-10-14T10:00:00Z')), logger });
  if (!local.ok) throw new Error(local.error.message);
  const { app, stormMode } = local.value;
  const server = await startNodeServer(app.handler, { host: '127.0.0.1', port: 0, path: '/mcp', maxBodyBytes: app.config.maxBodyBytes });
  cleanup.push(() => server.close());
  const client = new Client({ name: 'e2e-storm-story', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, [HOME_HEADER]: A } } }) as unknown as Transport);
  cleanup.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError, `${name}: ${JSON.stringify(r.structuredContent)}`).not.toBe(true);
    return { structured: r.structuredContent, text: (r.content as { text?: string }[]).map((c) => c.text ?? '').join(' ') };
  };
  /** Ana's phone, oldest first: the moment, the local time it was sent, the text. */
  const phone = async () => {
    const inbox = await stormMode.inbox(HomeIdSchema.parse(A));
    if (!inbox.ok) throw new Error(inbox.error.message);
    return [...inbox.value].reverse().map((m) => ({ transition: m.transition, at: new Date(m.at).toLocaleTimeString('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }), text: m.text }));
  };
  /** Skip ahead as the page does: to the first moment listed. */
  const skip = async (): Promise<GetMilestonesOutput['milestones'][number]> => {
    const list = GetMilestonesOutputSchema.parse((await call('get_milestones')).structured);
    const [next] = list.milestones;
    if (next === undefined) throw new Error('no moment ahead');
    await call('advance_clock', { kind: next.kind, at: next.at });
    return next;
  };
  return { call, phone, skip, logger };
}

/** The temperature a message says, in °C. */
const tempOf = (text: string) => Number(/is at (\d+\.\d) °C/.exec(text)?.[1]);

describe('the storm story of a sandbox (#390)', () => {
  it('forecast, storm, the essential level at night, power back: one message each, sane times and temperatures', async () => {
    const { call, phone, skip, logger } = await open();

    // 12:00, a storm is forecast: preparing tells Ana once, whatever the model asks again.
    const prepared = await call('start_storm_mode', { mode: 'prepare' });
    expect(prepared.text).toContain('Family told that a storm is expected: daughter (in_app).');
    expect(prepared.text).toContain('is covered for at least 24.0 hours, at least until 12:00 PM tomorrow.');
    await call('start_storm_mode', { mode: 'prepare' });
    expect((await phone()).map((m) => m.transition)).toEqual(['storm_prepared']);

    // The day's moments: the night now has a stop, the essential level at 21:00, between the storm and power back.
    const list = GetMilestonesOutputSchema.parse((await call('get_milestones')).structured);
    expect(list.milestones.map((m) => `${m.kind}@${m.at.slice(11, 16)}`)).toEqual(['storm_start@15:00', 'essential_level@21:00', 'power_back@06:40', 'next_recharge@08:00']);

    expect((await skip()).kind).toBe('storm_start');
    expect((await skip()).kind).toBe('essential_level');
    const night = SafeRoomStatusSchema.parse((await call('get_safe_room_status')).structured);
    expect(night).toMatchObject({ stormPhase: 'active', level: 'essential', gridAvailable: false });
    expect(night.tempC).toBeLessThanOrEqual(25);
    expect((await skip()).kind).toBe('power_back');

    const messages = await phone();
    expect(messages.map((m) => `${m.transition}@${m.at}`)).toEqual(['storm_prepared@12:00', 'storm_started@15:00', 'essential_level@21:00', 'power_back@06:40']);
    const [forecast, started, essential, back] = messages.map((m) => m.text);
    expect(forecast).toContain('a storm is expected and the home is ready for a power cut. Bedroom is at 26.0 °C; if the power goes out, the battery keeps it safe at least until 12:00 PM tomorrow.');
    // The storm-start time is never the time it is sent ("until 3:00 PM" at 3:00 PM): at the 24-hour cap it is a horizon.
    expect(started).toMatch(/Bedroom is at 26\.0 °C and the battery keeps it safe at least until 3:00 PM tomorrow\. No action is needed now\./);
    expect(essential).toMatch(/the battery reached the essential level, to keep Bedroom safe at least until 9:00 PM tomorrow\. Bedroom is at 25\.0 °C\. No action is needed now\./);
    // Power back: grandpa's room within his 24 °C night limit, so no action is needed (above it, the family would be asked to check).
    expect(back).toContain('power came back at home at 6:30 AM. Bedroom is at 24.0 °C. Storm mode has ended. No action is needed now.');
    for (const text of [started, essential, back]) expect(tempOf(text ?? '')).toBeLessThanOrEqual(26);

    // After power back the house is no longer in a storm: storm mode ended, the comfort level, the living room cooled again.
    const after = SafeRoomStatusSchema.parse((await call('get_safe_room_status')).structured);
    expect(after).toMatchObject({ stormPhase: 'ended', level: 'comfort', gridAvailable: true });
    expect((await call('get_home_status')).text).toContain('2 of 4 rooms served');

    // Skipping on tells no one more; the log lines carry the correlation id and never the sandbox id.
    await skip();
    expect((await phone()).map((m) => m.transition)).toEqual(['storm_prepared', 'storm_started', 'essential_level', 'power_back']);
    const jumps = logger.lines.filter((l) => l.details?.['event'] === 'clock_advanced');
    expect(jumps).toHaveLength(4);
    expect(jumps.every((l) => l.correlationId.length > 0)).toBe(true);
    expect(JSON.stringify(logger.lines)).not.toContain(A);
  }, 120_000);
});
