import { SafeRoomStatusSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { runStormDetector } from '../../src/modules/storm-mode/observe.js';
import { safeRoomStatus, startStormMode } from '../../src/modules/storm-mode/tools.js';
import { expectedSafeHours } from './expected.js';
import { MIN, preferences, stormConfig, world } from './support.js';

// get_safe_room_status is read-only: it reports the safe room, its hours and the stored storm, and never
// writes a session or sends a message. The storm detector runs in start_storm_mode and in the tick
// (runStormDetector, plan §9.2): the storm starts by itself on a measured grid loss and ends after a
// stable grid.

describe('get_safe_room_status', () => {
  it('before the storm: the measured room, its occupants, the chosen level and the safe hours', async () => {
    const w = world(1);
    const out = await safeRoomStatus(w.deps, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    const room = w.snapshot().rooms.find((r) => r.id === 'bedroom-1');
    expect(SafeRoomStatusSchema.parse(out.value)).toMatchObject({
      safeRoomId: 'bedroom-1',
      tempC: room?.tempC,
      occupantRoles: ['grandpa'],
      level: 'comfort',
      levelReason: 'user_choice',
      homeLink: 'ok',
    });
    expect(out.value.stormPhase).toBeUndefined();
    expect(out.value.origin.scenario).toBe('storm-blackout');
    expect(out.value.safeHours).toBeCloseTo(expectedSafeHours({ snapshot: w.snapshot(), forecast: w.forecast(), profile: w.profile, preferences, config: stormConfig() }), 6);
  });

  it('gives the time in the home time zone, with its offset', async () => {
    const w = world(1);
    const out = await safeRoomStatus(w.deps, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    expect(out.value.safeUntil).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+02:00$/); // Europe/Rome, summer time
    expect(Date.parse(out.value.safeUntil)).toBeCloseTo(w.clock.now() + out.value.safeHours * 3_600_000, -3);
  });

  it('is read-only: with the grid down it writes no session and sends no message', async () => {
    const w = world(4);
    const out = await safeRoomStatus(w.deps, w.ctx);
    expect(out.ok && out.value.stormPhase).toBeUndefined();
    const saved = await w.store.getLatestStormSession();
    expect(saved.ok && saved.value).toBeUndefined();
    expect(w.inbox()).toEqual([]);
  });

  it('reports the stored storm: Essential for the storm while it is active', async () => {
    const w = world(4);
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    const before = await w.store.getLatestStormSession();
    const out = await safeRoomStatus(w.deps, w.ctx);
    expect(out.ok && out.value).toMatchObject({ stormPhase: 'active', level: 'essential', levelReason: 'storm' });
    const after = await w.store.getLatestStormSession();
    expect(after).toEqual(before);
    expect(w.inbox()).toHaveLength(1);
  });

  it('with no reading from the safe room the status is not guessed', async () => {
    const w = world(1, { snapshot: (s) => ({ ...s, rooms: s.rooms.filter((r) => r.id !== 'bedroom-1') }) });
    const out = await safeRoomStatus(w.deps, w.ctx);
    expect(!out.ok && out.error).toMatchObject({ code: 'home_data_stale', details: { roomId: 'bedroom-1' } });
  });
});

describe('the storm detector (tick)', () => {
  it('a measured grid loss starts the storm by itself when the person allowed it, and tells the family once', async () => {
    const w = world(4);
    const out = await runStormDetector(w.deps, w.ctx);
    expect(out.ok && out.value.session?.phase).toBe('active');
    await runStormDetector(w.deps, w.ctx);
    expect(w.inbox().map((m) => m.transition)).toEqual(['storm_started']);
  });

  it('without that permission a grid loss starts nothing', async () => {
    const w = world(4, { preferences: { ...preferences, autoStormOnGridLoss: false } });
    const out = await runStormDetector(w.deps, w.ctx);
    expect(out.ok && out.value.session).toBeUndefined();
    expect(w.inbox()).toEqual([]);
  });

  it('power back: the storm ends after the stable-grid window, with the "power is back" message', async () => {
    const w = world(4);
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    w.advanceTo(19); // the grid came back at 18.5
    const back = await runStormDetector(w.deps, w.ctx);
    expect(back.ok && back.value.session?.phase).toBe('active');
    w.advanceTo(19 + (stormConfig().stableGridMinutes + 1) / 60);
    await runStormDetector(w.deps, w.ctx);
    const ended = await safeRoomStatus(w.deps, w.ctx);
    expect(ended.ok && ended.value).toMatchObject({ stormPhase: 'ended', level: 'comfort' });
    const [latest] = w.inbox();
    expect(latest?.transition).toBe('power_back');
    expect(latest?.text).toContain('power came back at home');
    expect(w.inbox()).toHaveLength(2);
    const session = await w.store.getLatestStormSession();
    expect(session.ok && session.value?.notifications.map((n) => n.transition)).toEqual(['storm_started', 'power_back']);
  });

  it('a grid that drops again inside the window keeps the storm going', async () => {
    let flicker = false;
    const w = world(4, { snapshot: (s) => (flicker ? { ...s, gridAvailable: false } : s) });
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    w.advanceTo(19);
    await runStormDetector(w.deps, w.ctx); // grid back: the window starts
    flicker = true;
    w.clock.set(w.clock.now() + 5 * MIN);
    await runStormDetector(w.deps, w.ctx); // down again: the window starts over
    flicker = false;
    w.clock.set(w.clock.now() + 5 * MIN);
    await runStormDetector(w.deps, w.ctx);
    w.clock.set(w.clock.now() + 6 * MIN);
    const out = await runStormDetector(w.deps, w.ctx);
    expect(out.ok && out.value.session?.phase).toBe('active');
    expect(w.inbox()).toHaveLength(1);
  });
});
