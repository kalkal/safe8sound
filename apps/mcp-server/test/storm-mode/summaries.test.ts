import { describe, expect, it } from 'vitest';
import { celsius } from '@cold-reserve/contracts';
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
    expect(text).toContain(`about ${one(out.value.safeHours)} hours, until ${localTimeText(out.value.safeUntil)}`);
    expect(text).toMatch(/until \d{1,2}:\d\d [AP]M/);
    // The person hears the clock time only, never an ISO stamp (#160 acceptance test).
    expect(text).not.toMatch(/\d{4}-\d\d-\d\dT/);
    expect(text).not.toMatch(/Giulia|phone-/);
    expect(text).toContain('No family message was sent.');
  });

  it('start_storm_mode with the grid down: active, reserve unlocked, and who was told', async () => {
    const w = world(4);
    const out = await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    const text = startSummary(out.value);
    expect(text).toContain('Storm mode is active: the grid is down, so the storm reserve is now the budget.');
    expect(text).toContain('Family told that the storm started: daughter (in_app).');
    expect(text).not.toMatch(/Giulia|phone-/);
  });

  it('get_safe_room_status: room, temperature, humidity, occupants, level with reason, hours, storm and data origin', async () => {
    const w = world(4);
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    const out = await safeRoomStatus(w.deps, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    const s = out.value;
    const text = safeRoomSummary(s);
    expect(text).toContain(`Safe room ${s.safeRoomId}: ${one(s.tempC)} °C, ${String(s.humidityPct)} % humidity, occupants: Leo (grandpa).`);
    expect(text).toContain('Level essential (reason: storm).');
    expect(text).toContain(`Safe for about ${one(s.safeHours)} hours, until ${localTimeText(s.safeUntil)}.`);
    expect(text).not.toMatch(/Giulia|phone-/);
    expect(text).toContain('Storm mode: active.');
    expect(text).toContain('simulated data (');
  });

  it('the storm tools say the safe room by its name, with its id: "Bedroom 1 (bedroom-1)"', async () => {
    const w = world(4);
    const tools = stormModeModule(w.deps).tools;
    const said = (name: string, output: unknown) => tools.find((t) => t.name === name)?.summarize?.(output, w.ctx) ?? '';
    const started = await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    if (!started.ok) throw new Error(started.error.message);
    const status = await safeRoomStatus(w.deps, w.ctx);
    if (!status.ok) throw new Error(status.error.message);
    const room = w.deps.homes(w.ctx.homeId)?.profile.rooms.find((r) => r.id === status.value.safeRoomId);
    if (room === undefined) throw new Error('no safe room in the profile');
    expect(said('start_storm_mode', started.value)).toContain(`The safe room, ${room.name} (${room.id}), is covered`);
    expect(said('get_safe_room_status', status.value)).toContain(`Safe room ${room.name} (${room.id}): `);
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
    expect(safeRoomSummary(out.value, 'F')).toContain(`Safe room ${out.value.safeRoomId}: ${f.toFixed(1)} °F`);
    expect(safeRoomSummary(out.value, 'F')).not.toContain('°C');
    const told = await w.inbox();
    expect(told.map((m) => m.text).join(' ')).toMatch(/is at \d+\.\d °F/);
    expect(told.map((m) => m.text).join(' ')).not.toContain('°C');
    const note = await notifyFamily(w.deps, { transition: 'essential_level' }, w.ctx);
    expect(note.ok && note.value.preview).toMatch(/is at \d+\.\d °F/);
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
    expect(text).not.toMatch(/Giulia|phone-/);
  });

  it('says the local clock time the way the family message does, then the exact time', () => {
    expect(localTimeText('2026-07-17T21:05:00+02:00')).toBe('9:05 PM');
    expect(localTimeText('2026-07-18T00:30:00+02:00')).toBe('12:30 AM');
    expect(localTimeText('2026-07-18T12:00:00+02:00')).toBe('12:00 PM');
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
