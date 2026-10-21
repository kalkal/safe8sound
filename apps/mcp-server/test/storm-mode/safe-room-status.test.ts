import { HomeProfileSchema, PlanSchema, SafeRoomStatusSchema, pct, type ActivePlan, type HomeProfile } from '@cold-reserve/contracts';
import { examplePlan } from '@cold-reserve/contracts/fixtures';
import { activePlanNow } from '../../src/modules/storm-mode/active-plan.js';
import { describe, expect, it } from 'vitest';
import { runStormDetector } from '../../src/modules/storm-mode/observe.js';
import { safeRoomStatus, startStormMode } from '../../src/modules/storm-mode/tools.js';
import { expectedHold, expectedSafeHours } from './expected.js';
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

  it('on a home without its EPS load, refuses to count safe hours rather than assume one (#107)', async () => {
    const bare = (p: HomeProfile) => HomeProfileSchema.parse(Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'epsBaseLoadW')));
    const w = world(4, { profile: bare });
    const out = await safeRoomStatus(w.deps, w.ctx);
    expect(!out.ok && out.error).toMatchObject({ code: 'missing_eps_load', category: 'internal' });
  });

  it('gives the time in the home time zone, with its offset, counted from the home\'s reading', async () => {
    const w = world(1);
    const out = await safeRoomStatus(w.deps, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    expect(out.value.safeUntil).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+02:00$/); // Europe/Rome, summer time
    const held = expectedHold({ snapshot: w.snapshot(), forecast: w.forecast(), profile: w.profile, preferences, config: stormConfig() });
    expect(Date.parse(out.value.safeUntil)).toBeCloseTo(held.untilMs, -3);
  });

  it('says when the time is only the end of the projection (the clear day: the battery outlasts it), so a screen says "at least"', async () => {
    const clear = world(12, {}, 'clear-day');
    const capped = await safeRoomStatus(clear.deps, clear.ctx);
    if (!capped.ok) throw new Error(capped.error.message);
    expect(SafeRoomStatusSchema.parse(capped.value).safeUntilCapped).toBe(true);
    expect(capped.value.safeHours).toBe(stormConfig().capHours);
    const storm = world(4, { snapshot: (s) => ({ ...s, batterySocPct: pct(12) }) });
    const held = await safeRoomStatus(storm.deps, storm.ctx);
    if (!held.ok) throw new Error(held.error.message);
    expect(held.value.safeHours).toBeLessThan(stormConfig().capHours);
    expect(held.value.safeUntilCapped).toBeUndefined();
  });

  it('is read-only: with the grid down it writes no session and sends no message', async () => {
    const w = world(4);
    const out = await safeRoomStatus(w.deps, w.ctx);
    expect(out.ok && out.value.stormPhase).toBeUndefined();
    const saved = await w.store.getLatestStormSession();
    expect(saved.ok && saved.value).toBeUndefined();
    expect((await w.inbox())).toEqual([]);
  });

  it('reports the stored storm: Saver for the storm while it is active, before the essential moment (#429)', async () => {
    const w = world(4);
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    const before = await w.store.getLatestStormSession();
    const out = await safeRoomStatus(w.deps, w.ctx);
    expect(out.ok && out.value).toMatchObject({ stormPhase: 'active', level: 'saver', levelReason: 'storm' });
    const after = await w.store.getLatestStormSession();
    expect(after).toEqual(before);
    expect((await w.inbox())).toHaveLength(1);
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
    expect((await w.inbox()).map((m) => m.transition)).toEqual(['storm_started']);
  });

  it('without that permission a grid loss starts nothing', async () => {
    const w = world(4, { preferences: { ...preferences, autoStormOnGridLoss: false } });
    const out = await runStormDetector(w.deps, w.ctx);
    expect(out.ok && out.value.session).toBeUndefined();
    expect((await w.inbox())).toEqual([]);
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
    const [latest] = (await w.inbox());
    expect(latest?.transition).toBe('power_back');
    expect(latest?.text).toContain('power came back at home');
    expect((await w.inbox())).toHaveLength(2);
    const session = await w.store.getLatestStormSession();
    expect(session.ok && session.value?.notifications.map((n) => n.transition)).toEqual(['storm_started', 'power_back']);
  });

  it('#311: the essential reading tells the family once, during an active storm only', async () => {
    const w = world(4);
    await runStormDetector(w.deps, w.ctx, 'essential'); // the storm starts on this reading: no essential yet
    await runStormDetector(w.deps, w.ctx, 'essential');
    await runStormDetector(w.deps, w.ctx, 'essential');
    expect((await w.inbox()).map((m) => m.transition).sort()).toEqual(['essential_level', 'storm_started']);
    const calm = world(1);
    await runStormDetector(calm.deps, calm.ctx, 'essential');
    expect(await calm.inbox()).toEqual([]);
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
    expect((await w.inbox())).toHaveLength(1);
  });
});

// The rest tile says a plan is running (owner, 21 Oct): the safe room's status carries the plan applied last while it
// runs. It runs until its horizon; a storm started since replaces it; the home's own clock reads the times.
describe('the active plan of the safe room status', () => {
  const active = { planId: 'plan_7Hq2mX9vK3', appliedAt: '2026-07-15T14:00:00+02:00', until: '2026-07-16T07:00:00+02:00' } as ActivePlan;
  const at = (iso: string) => Date.parse(iso);

  it('runs from its apply until its horizon, its time on the home clock', () => {
    expect(activePlanNow({ active, session: undefined, nowMs: at('2026-07-15T18:00:00+02:00'), timeZone: 'Europe/Rome' })).toEqual({ planId: 'plan_7Hq2mX9vK3', until: '2026-07-16T07:00:00+02:00' });
    expect(activePlanNow({ active, session: undefined, nowMs: at('2026-07-16T07:00:00+02:00'), timeZone: 'Europe/Rome' })).toBeUndefined();
    expect(activePlanNow({ active: undefined, session: undefined, nowMs: at('2026-07-15T18:00:00+02:00'), timeZone: 'Europe/Rome' })).toBeUndefined();
  });

  it('a storm started since the apply replaces it; a storm before it does not', () => {
    const storm = (startedAt: string) => ({ startedAt }) as never;
    expect(activePlanNow({ active, session: storm('2026-07-15T19:00:00+02:00'), nowMs: at('2026-07-15T20:00:00+02:00'), timeZone: 'Europe/Rome' })).toBeUndefined();
    expect(activePlanNow({ active, session: storm('2026-07-14T19:00:00+02:00'), nowMs: at('2026-07-15T20:00:00+02:00'), timeZone: 'Europe/Rome' })).toMatchObject({ planId: 'plan_7Hq2mX9vK3' });
  });

  it('get_safe_room_status says it once a plan is applied in the store; without one, nothing', async () => {
    const w = world(1, {}, 'heatwave');
    const before = await safeRoomStatus(w.deps, w.ctx);
    if (!before.ok) throw new Error(before.error.message);
    expect(before.value.activePlan).toBeUndefined();
    const now = Date.parse(w.snapshot().ts);
    const plan = PlanSchema.parse({ ...examplePlan(), homeId: 'demo', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 10 * MIN).toISOString(), horizonAt: new Date(now + 12 * 60 * MIN).toISOString(), steps: examplePlan().steps.map((s) => ({ ...s, ts: new Date(now + 60 * MIN).toISOString() })) });
    await w.store.savePlan(plan);
    expect((await w.store.applyPlan(plan.id, now)).ok).toBe(true);
    const after = await safeRoomStatus(w.deps, w.ctx);
    if (!after.ok) throw new Error(after.error.message);
    expect(SafeRoomStatusSchema.parse(after.value).activePlan).toMatchObject({ planId: plan.id });
  });
});
