import { HomeIdSchema, StartStormModeOutputSchema, err, toolError } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { startStormMode } from '../../src/modules/storm-mode/tools.js';
import { expectedSafeHours } from './expected.js';
import { preferences, stormConfig, world } from './support.js';

// start_storm_mode (plan §4, §9.4): "active" unlocks the reserve only with the grid measured down.

describe('start_storm_mode', () => {
  it('with the grid up, "active" is only a preparation: the reserve stays locked and nobody is messaged', async () => {
    const w = world(1);
    const out = await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    expect(out.ok && StartStormModeOutputSchema.parse(out.value)).toMatchObject({
      effectiveMode: 'prepare',
      reserveUnlocked: false,
      reason: 'grid_still_up',
      session: { phase: 'prepare', trigger: 'user', safeRoomId: 'bedroom-1', occupantRoles: ['grandpa'], notifications: [] },
    });
    expect(w.inbox()).toEqual([]);
  });

  it('"prepare" with the grid up says it was requested', async () => {
    const w = world(1);
    const out = await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    expect(out.ok && out.value.reason).toBe('requested');
  });

  it('with the grid down the storm is active whatever was asked, and the family gets the storm_started message', async () => {
    const w = world(4);
    const out = await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    expect(StartStormModeOutputSchema.parse(out.value)).toMatchObject({ effectiveMode: 'active', reserveUnlocked: true, reason: 'grid_lost', session: { phase: 'active', trigger: 'grid_loss' } });
    expect(out.value.session.notifications).toEqual([{ at: new Date(w.clock.now()).toISOString(), transition: 'storm_started', contactRole: 'daughter', channel: 'in_app', delivered: true }]);
    const [message] = w.inbox();
    expect(message).toMatchObject({ role: 'daughter', transition: 'storm_started' });
    expect(message?.text).toMatch(/^.+ alert for Giulia Example: a storm cut the power at home\. Bedroom is at \d+\.\d °C/);
  });

  it('asking again changes nothing and sends nothing more', async () => {
    const w = world(4);
    const first = await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    const again = await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    expect(again.ok && first.ok && again.value.session).toEqual(first.ok && first.value.session);
    expect(w.inbox()).toHaveLength(1);
  });

  it('quotes the safe hours of the #23 formula, until when, and keeps them as hoursAtEssential', async () => {
    const w = world(4);
    const out = await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    const expected = expectedSafeHours({ snapshot: w.snapshot(), forecast: w.forecast(), profile: w.profile, preferences, config: stormConfig() });
    expect(out.value.safeHours).toBeCloseTo(expected, 6);
    expect(out.value.session.hoursAtEssential).toBeCloseTo(expected, 6);
    expect(Date.parse(out.value.safeUntil)).toBeCloseTo(w.clock.now() + expected * 3_600_000, -3);
  });

  it('runs the detector first: after a storm, with the grid back and stable, it ends the storm with "power is back"', async () => {
    const w = world(4);
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    w.advanceTo(19);
    await startStormMode(w.deps, { mode: 'prepare' }, w.ctx); // the grid is back: the window starts
    w.advanceTo(19 + (stormConfig().stableGridMinutes + 1) / 60);
    const out = await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    expect(w.inbox().map((m) => m.transition)).toEqual(['power_back', 'storm_started']);
    // The request itself then opens a new preparation, as asked.
    expect(out.ok && out.value).toMatchObject({ effectiveMode: 'prepare', reason: 'requested', session: { phase: 'prepare', notifications: [] } });
  });

  it('saves the session in the store', async () => {
    const w = world(4);
    const out = await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    const saved = await w.store.getLatestStormSession();
    expect(saved.ok && saved.value).toEqual(out.ok && out.value.session);
  });

  it('a failed delivery is recorded as not delivered, and the storm still starts', async () => {
    const w = world(4, { notifier: { send: () => Promise.resolve(err(toolError('store_unavailable', 'The phone is down.'))) } });
    const out = await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    expect(out.ok && out.value.session.notifications).toEqual([expect.objectContaining({ contactRole: 'daughter', delivered: false })]);
  });

  it('refuses a home the server does not know', async () => {
    const w = world(4);
    const out = await startStormMode(w.deps, { mode: 'active' }, { ...w.ctx, homeId: HomeIdSchema.parse('elsewhere') });
    expect(!out.ok && out.error.code).toBe('home_not_found');
  });

  it('passes on a failed reading of the home', async () => {
    const w = world(4);
    const home = w.deps.homes(w.ctx.homeId);
    if (!home) throw new Error('the demo home is missing');
    const deps = { ...w.deps, homes: () => ({ ...home, source: { snapshot: () => Promise.resolve(err(toolError('home_data_stale', 'No reading.'))) } }) };
    const out = await startStormMode(deps, { mode: 'active' }, w.ctx);
    expect(!out.ok && out.error.code).toBe('home_data_stale');
  });
});
