import { HomeIdSchema, type HomeId } from '@cold-reserve/contracts';
import { createSimulatedDevices } from '@cold-reserve/source-simulator';
import { describe, expect, it } from 'vitest';
import { safeRoomStatus, startStormMode } from '../../src/modules/storm-mode/tools.js';
import { safeRoomSummary, startSummary } from '../../src/modules/storm-mode/summaries.js';
import { world } from './support.js';

// Queue item 7 (approved in #24): the house gets ready for the storm. Only the simulated adapter
// exists; on the read-only home nothing is ever called and the agent says what to do by hand.

const SANDBOX = HomeIdSchema.parse('demo#0123456789abcdef');

function withDevices(atH: number, options: { readOnly?: boolean; failing?: string[]; throwing?: boolean } = {}) {
  const w = world(atH);
  const devices = createSimulatedDevices({ failing: options.failing ?? [] });
  const base = w.deps.homes;
  const deps = {
    ...w.deps,
    devices: options.throwing === true ? { secure: () => Promise.reject(new TypeError('socket closed: secret-detail')) } : devices.adapter,
    // The sandbox visitor sees the demo house.
    homes: (h: HomeId) => {
      const home = base(h === SANDBOX ? w.ctx.homeId : h);
      return home && { ...home, readOnly: options.readOnly ?? false };
    },
  };
  return { ...w, deps, devices };
}

describe('the house gets ready for the storm (demo homes)', () => {
  it('docks the mower and closes the shutter when the storm is prepared, once', async () => {
    const w = withDevices(1);
    const out = await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    expect(out.value.session.devicesSecured?.map((d) => `${d.entityId}:${d.action}:${d.outcome}`)).toEqual(['lawn_mower.garden:dock:done', 'cover.living_room:close:done']);
    expect(out.value.deviceAdvice).toBeUndefined();
    await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    expect(w.devices.secured()).toEqual(['lawn_mower.garden', 'cover.living_room']);
  });

  it('a storm that starts with the grid already down makes the house safe too', async () => {
    const w = withDevices(4);
    const out = await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    expect(out.ok && out.value.session.devicesSecured).toHaveLength(2);
  });

  it('a device that does not answer is recorded as failed; the storm goes on', async () => {
    const w = withDevices(1, { failing: ['cover.living_room'] });
    const out = await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    expect(out.ok && out.value.session.devicesSecured?.map((d) => d.outcome)).toEqual(['done', 'failed']);
  });

  it('logs one warn line per failed device: the code, the entity, the correlation id, never a name (#172 review)', async () => {
    const w = withDevices(1, { failing: ['cover.living_room'] });
    await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    const warns = w.logs.filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      level: 'warn',
      component: 'mcp-server',
      correlationId: 'test-correlation',
      homeId: 'demo',
      code: 'device_unreachable',
      details: { event: 'storm_device_failed', entityId: 'cover.living_room' },
    });
    expect(JSON.stringify(warns)).not.toContain('did not answer');
  });

  it('a device that throws is logged as unexpected_error with the error name only', async () => {
    const w = withDevices(1, { throwing: true });
    const out = await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    expect(out.ok && out.value.session.devicesSecured?.map((d) => d.outcome)).toEqual(['failed', 'failed']);
    const warns = w.logs.filter((l) => l.level === 'warn');
    expect(warns.map((l) => [l.code, l.details?.['errorName']])).toEqual([
      ['unexpected_error', 'TypeError'],
      ['unexpected_error', 'TypeError'],
    ]);
    expect(JSON.stringify(warns)).not.toContain('secret-detail');
  });

  it('a sandbox home is said as "sandbox" in the log line, never by its id (#134)', async () => {
    const w = withDevices(1, { failing: ['cover.living_room'] });
    await startStormMode(w.deps, { mode: 'prepare' }, { ...w.ctx, homeId: SANDBOX });
    const warn = w.logs.find((l) => l.level === 'warn');
    expect(warn?.details).toMatchObject({ home: 'sandbox' });
    expect(warn?.homeId).toBeUndefined();
    expect(JSON.stringify(w.logs)).not.toContain('0123456789abcdef');
  });

  it('the summary names devices by a fixed label, never by a name from the home', async () => {
    const w = withDevices(1, { failing: ['cover.living_room'] });
    const out = await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    const text = startSummary(out.value);
    expect(text).toContain('Made safe before the storm: the robot mower is docked.');
    expect(text).toContain('Could not reach the shutters: check them by hand.');
  });
});

describe('the real home is read-only (plan §13.2 p.1)', () => {
  it('never calls the adapter: it only says what to do by hand', async () => {
    const w = withDevices(1, { readOnly: true });
    const out = await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    expect(w.devices.secured()).toEqual([]);
    expect(out.value.session.devicesSecured).toBeUndefined();
    expect(out.value.deviceAdvice).toEqual([
      { domain: 'lawn_mower', action: 'dock' },
      { domain: 'cover', action: 'close' },
    ]);
    expect(startSummary(out.value)).toContain('Please do this by hand: bring the robot mower back to its base, close the shutters.');
  });
});

describe('without a device adapter in the deps', () => {
  it('starts the storm and records nothing about devices', async () => {
    const w = world(1);
    const out = await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    expect(out.ok && out.value.session.devicesSecured).toBeUndefined();
  });
});

describe('the last check-in from the family (queue item 3)', () => {
  it('get_safe_room_status gives the latest reply by role, in the home time zone; the summary says it without a name', async () => {
    const w = world(4);
    const started = await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    if (!started.ok) throw new Error(started.error.message);
    const replies = [
      { role: 'daughter', reply: 'check_status' as const, at: '2026-09-30T19:20:00Z' },
      { role: 'daughter', reply: 'on_my_way' as const, at: '2026-09-30T19:30:00Z' },
    ];
    await w.store.saveStormSession({ ...started.value.session, familyReplies: replies });
    const out = await safeRoomStatus(w.deps, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    expect(out.value.lastCheckIn).toEqual({ role: 'daughter', reply: 'on_my_way', at: '2026-09-30T21:30:00+02:00' });
    const text = safeRoomSummary(out.value);
    expect(text).toContain('Last check-in: your daughter is on the way (9:30 PM (2026-09-30T21:30:00+02:00)).');
    expect(text).not.toMatch(/Giulia|phone-/);
  });

  it('says nothing about check-ins when there are none', async () => {
    const w = world(4);
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    const out = await safeRoomStatus(w.deps, w.ctx);
    expect(out.ok && out.value.lastCheckIn).toBeUndefined();
    expect(out.ok && safeRoomSummary(out.value)).not.toContain('check-in');
  });

  it('after the storm has ended, an old check-in is not said any more (#172 review)', async () => {
    const w = world(4);
    const started = await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    if (!started.ok) throw new Error(started.error.message);
    const replies = [{ role: 'daughter', reply: 'on_my_way' as const, at: '2026-09-30T19:30:00Z' }];
    const saved = await w.store.saveStormSession({ ...started.value.session, phase: 'ended', endedAt: '2026-09-30T20:00:00Z', familyReplies: replies });
    if (!saved.ok) throw new Error(saved.error.message);
    const out = await safeRoomStatus(w.deps, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    expect(out.value.lastCheckIn).toBeUndefined();
    expect(safeRoomSummary(out.value)).not.toContain('check-in');
  });
});
