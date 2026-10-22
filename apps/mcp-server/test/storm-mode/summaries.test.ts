import { describe, expect, it } from 'vitest';
import { CARD_TOOL_ACCESS, SafeRoomStatusSchema, celsius } from '@cold-reserve/contracts';
import { notifySummary, safeRoomSummary, startSummary } from '../../src/modules/storm-mode/summaries.js';
import { stormModeModule } from '../../src/modules/storm-mode/index.js';
import { localIso, localTimeText } from '@cold-reserve/core';
import { notifyFamily, safeRoomStatus, startStormMode } from '../../src/modules/storm-mode/tools.js';
import { world } from './support.js';

// The agent reads only the text content (F7): safe hours, until when, the level and its reason, and
// the roles messaged or skipped are all in it. Names and handles never are.

const one = (x: number) => x.toFixed(1);

describe('what the model reads', () => {
  it('start_storm_mode with the grid up: prepared, reserve locked, why, and the hours', async () => {
    const w = world(1);
    const out = await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    const text = startSummary(out.value);
    expect(text).toContain('Storm mode is prepared: the grid is still up, so the storm reserve stays locked.');
    // #390: at the 24-hour cap the same clock time is tomorrow's, and the text says so.
    expect(text).toContain(`about ${one(out.value.safeHours)} hours, until ${localTimeText(out.value.safeUntil)} tomorrow`);
    expect(text).toMatch(/until \d{2}:\d\d/);
    // The person hears the clock time only, never an ISO stamp (#160 acceptance test).
    expect(text).not.toMatch(/\d{4}-\d\d-\d\dT/);
    expect(text).not.toMatch(/(^|[^A-Za-z])Ana([^A-Za-z]|$)|phone-/);
    // #390: preparing a storm tells the family once (the forecast message), by role and channel only.
    expect(text).toContain('Family told that a storm is expected: daughter (in_app).');
  });

  it('start_storm_mode with the grid down: active, reserve unlocked, and who was told', async () => {
    const w = world(4);
    const out = await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    const text = startSummary(out.value);
    expect(text).toContain('Storm mode is active: the grid is down, so the storm reserve is now the budget.');
    expect(text).toContain('Family told that the storm started: daughter (in_app).');
    expect(text).not.toMatch(/(^|[^A-Za-z])Ana([^A-Za-z]|$)|phone-/);
  });

  it('get_safe_room_status: room, temperature, humidity, occupants, level with reason, hours, storm and data origin', async () => {
    const w = world(4);
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    const out = await safeRoomStatus(w.deps, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    const s = out.value;
    const text = safeRoomSummary(s);
    expect(text).toContain(`Safe room: ${one(s.tempC)} °C, ${String(s.humidityPct)} % humidity, occupants: Leo (grandpa).`);
    expect(text).toContain('Level saver (reason: storm).');
    expect(text).toContain(`Safe for about ${one(s.safeHours)} hours, until ${localTimeText(s.safeUntil)}${s.safeHours >= 24 ? ' tomorrow' : ''}.`);
    expect(text).not.toMatch(/(^|[^A-Za-z])Ana([^A-Za-z]|$)|phone-/);
    expect(text).toContain('Storm mode: active.');
    expect(text).toContain('simulated data (');
  });

  // #432 S6: the Echo's idle tile reads get_safe_room_status as a card call; the call map says read, as the tool does.
  it('get_safe_room_status is read-only, as the card call map says', () => {
    const tool = stormModeModule(world(4).deps).tools.find((t) => t.name === 'get_safe_room_status');
    expect(tool?.annotations.readOnlyHint).toBe(CARD_TOOL_ACCESS.get_safe_room_status === 'read');
  });

  it('the storm tools say the safe room by its name, never its id (#192)', async () => {
    const w = world(4);
    const tools = stormModeModule(w.deps).tools;
    const said = (name: string, output: unknown) => tools.find((t) => t.name === name)?.summarize?.(output, w.ctx) ?? '';
    const started = await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    if (!started.ok) throw new Error(started.error.message);
    const status = await safeRoomStatus(w.deps, w.ctx);
    if (!status.ok) throw new Error(status.error.message);
    const room = w.deps.homes(w.ctx.homeId)?.profile.rooms.find((r) => r.id === status.value.safeRoomId);
    if (room === undefined) throw new Error('no safe room in the profile');
    expect(status.value.safeRoomName).toBe(room.name);
    expect(said('start_storm_mode', started.value)).toContain(`The safe room, ${room.name}, is covered`);
    expect(said('get_safe_room_status', status.value)).toContain(`Safe room ${room.name}: `);
  });

  it('#271: at 22:00 with an older person, 27 °C is said above the night limit of 24 °C, and the grandpa by his fictional name', async () => {
    const w = world(22, { snapshot: (s) => ({ ...s, rooms: s.rooms.map((r) => (r.occupants.includes('grandpa') ? { ...r, tempC: celsius(27) } : r)) }) }, 'heatwave');
    const out = await safeRoomStatus(w.deps, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    expect(out.value.limitNow).toEqual({ limitC: 24, kind: 'night' });
    expect(out.value.people).toEqual([{ role: 'grandpa', name: 'Leo' }]);
    const text = safeRoomSummary(out.value);
    expect(text).toContain('occupants: Leo (grandpa). It is above the night limit of 24.0 °C now.');
    expect(safeRoomSummary(out.value, 'F')).toContain('It is above the night limit of 75.2 °F now.');
    // Inside the limit nothing is added.
    const cool = world(22, { snapshot: (s) => ({ ...s, rooms: s.rooms.map((r) => (r.occupants.includes('grandpa') ? { ...r, tempC: celsius(23) } : r)) }) }, 'heatwave');
    const fine = await safeRoomStatus(cool.deps, cool.ctx);
    if (!fine.ok) throw new Error(fine.error.message);
    expect(safeRoomSummary(fine.value)).not.toContain('above the');
  });

  it('in °F (#306): the safe room in °F, and the family told in °F too', async () => {
    const w = world(4, { units: 'F' });
    const started = await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    if (!started.ok) throw new Error(started.error.message);
    const out = await safeRoomStatus(w.deps, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    // The structured status stays in °C; the text the model reads is in °F.
    const f = Math.round((out.value.tempC * 1.8 + 32) * 10) / 10;
    expect(safeRoomSummary(out.value, 'F')).toContain(`Safe room: ${f.toFixed(1)} °F`);
    expect(safeRoomSummary(out.value, 'F')).not.toContain('°C');
    const told = await w.inbox();
    expect(told.map((m) => m.text).join(' ')).toMatch(/is at \d+\.\d °F/);
    expect(told.map((m) => m.text).join(' ')).not.toContain('°C');
    const note = await notifyFamily(w.deps, { transition: 'essential_level' }, w.ctx);
    expect(note.ok && note.value.preview).toMatch(/is at \d+\.\d °F/);
  });

  it('#438: get_safe_room_status names the emergency number of the place, as context for a health worry only', async () => {
    for (const [place, number] of [['houston', '911'], ['turin', '112'], ['reference', '112']] as const) {
      const w = world(4, { place });
      const tools = stormModeModule(w.deps).tools;
      const status = await safeRoomStatus(w.deps, w.ctx);
      if (!status.ok) throw new Error(status.error.message);
      const said = tools.find((t) => t.name === 'get_safe_room_status')?.summarize?.(status.value, w.ctx) ?? '';
      expect(said).toContain(`Context, to say only if someone may be unwell: the emergency number here is ${number}.`);
    }
  });

  it('#438: with no place known, no emergency number is said (never a default one, #376)', async () => {
    const w = world(4);
    const status = await safeRoomStatus(w.deps, w.ctx);
    if (!status.ok) throw new Error(status.error.message);
    const said = stormModeModule(w.deps).tools.find((t) => t.name === 'get_safe_room_status')?.summarize?.(status.value, w.ctx) ?? '';
    expect(said).not.toMatch(/emergency number|\b(112|911)\b/);
  });

  it('#438, owner 22 Oct: get_safe_room_status carries the number of the place in its result, for the agent\'s fixed answer; none without a place', async () => {
    for (const [place, number] of [['houston', '911'], ['turin', '112'], ['reference', '112']] as const) {
      const w = world(4, { place });
      const tool = stormModeModule(w.deps).tools.find((t) => t.name === 'get_safe_room_status');
      const out = await tool?.handler({}, w.ctx);
      expect(out?.ok && out.value).toMatchObject({ emergencyNumber: number });
      expect(SafeRoomStatusSchema.safeParse(out?.ok ? out.value : undefined).success).toBe(true);
    }
    const w = world(4);
    const out = await stormModeModule(w.deps).tools.find((t) => t.name === 'get_safe_room_status')?.handler({}, w.ctx);
    expect(out?.ok).toBe(true);
    expect(out?.ok ? out.value : undefined).not.toHaveProperty('emergencyNumber');
  });

  it('notify_family: sent and skipped roles, and the preview addressed to the role', async () => {
    const w = world(4);
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    const out = await notifyFamily(w.deps, { transition: 'essential_level', roles: ['daughter', 'neighbor'] }, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    const text = notifySummary(out.value);
    expect(text).toContain('Message sent to: daughter (in_app).');
    expect(text).toContain('Not sent to: neighbor (not a registered contact).');
    expect(text).toContain(`Message: ${out.value.preview}`);
    expect(text).not.toMatch(/(^|[^A-Za-z])Ana([^A-Za-z]|$)|phone-/);
  });

  it('says the local clock time the way the family message does, then the exact time', () => {
    expect(localTimeText('2026-07-17T21:05:00+02:00')).toBe('21:05');
    expect(localTimeText('2026-07-18T00:30:00+02:00')).toBe('00:30');
    expect(localTimeText('2026-07-18T12:00:00+02:00')).toBe('12:00');
  });

  it('notify_family inside the interval says nothing was sent and why', () => {
    expect(notifySummary({ sent: [], skipped: [{ role: 'daughter', reason: 'rate_limited' }], preview: 'x' })).toContain(
      'Not sent to: daughter (already told recently).',
    );
  });
});

describe('localIso', () => {
  it('writes the instant in the home time zone with its offset, summer and winter', () => {
    expect(localIso(Date.parse('2026-07-17T19:30:00Z'), 'Europe/Rome')).toBe('2026-07-17T21:30:00+02:00');
    expect(localIso(Date.parse('2026-01-10T23:15:00Z'), 'Europe/Rome')).toBe('2026-01-11T00:15:00+01:00');
    expect(localIso(Date.parse('2026-01-10T23:15:00Z'), 'UTC')).toBe('2026-01-10T23:15:00+00:00');
  });
});

describe('#364: the room time leads, the battery time follows', () => {
  const base = {
    safeRoomId: 'bedroom-1',
    tempC: celsius(23.8),
    occupantRoles: ['grandpa'],
    level: 'essential',
    levelReason: 'storm',
    safeHours: 7.2,
    safeUntil: '2026-07-18T03:05:00+02:00',
    stormPhase: 'active',
    gridAvailable: false,
    origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated' },
    homeLink: 'ok',
  };
  const status = (withinLimits: object) => SafeRoomStatusSchema.parse({ ...base, withinLimits });

  it('with the limit crossed: both times, the room first, and every number on the card', () => {
    const text = safeRoomSummary(status({ until: '2026-07-18T06:00:00+02:00', limitC: celsius(24) }));
    expect(text).toContain('The safe room stays at or below its 24 °C limit until about 06:00 tomorrow; the battery lasts until 03:05 tomorrow (about 7.2 hours), then the room warms up.');
    expect(text).not.toContain('Safe for about');
    const f = safeRoomSummary(status({ until: '2026-07-18T06:00:00+02:00', limitC: celsius(24) }), 'F');
    expect(f).toContain('at or below its 75.2 °F limit until about 06:00 tomorrow');
  });

  it('inside its limits to the end of the projection: "at least until"', () => {
    const text = safeRoomSummary(status({ until: '2026-07-18T20:00:00+02:00' }));
    expect(text).toContain('The safe room stays within its limits at least until 20:00 tomorrow; the battery lasts until 03:05 tomorrow (about 7.2 hours).');
    // #390: read at 19:53, both times are on the next day, and the text says so.
    expect(text).not.toMatch(/until 03:05;/);
  });
});

describe('#390 review: at the cap of the projection the hours are a horizon', () => {
  it('says "at least" for the hours and the time, never "about … until" as an end', async () => {
    const w = world(4);
    const out = await safeRoomStatus(w.deps, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    expect(out.value.safeHours).toBe(24);
    const text = safeRoomSummary(out.value, 'C', undefined, 24);
    expect(text).toContain(`Safe for at least 24.0 hours, at least until ${localTimeText(out.value.safeUntil)} tomorrow.`);
    expect(safeRoomSummary(out.value)).toContain('Safe for about 24.0 hours');
  });
});
