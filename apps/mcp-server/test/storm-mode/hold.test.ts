import { pct, type HomeId } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { safeRoomStatus } from '../../src/modules/storm-mode/tools.js';
import { expectedHold } from './expected.js';
import { preferences, stormConfig, world } from './support.js';

// Q7-A of #24: storm mode's safe hours are a thin wrapper over the guard's hold of the safe room
// (holdSafeRoom, #174). One physics with the last-resort plan: the night limit, pre-cooled toward it within
// the lead, dry or cool by humidity, the battery down to its hardware floor.

const H = 3_600_000;

describe('storm safe hours on the guard\'s hold', () => {
  it('during the blackout: the projection\'s safe-until, capped at capHours', async () => {
    const w = world(4);
    const out = await safeRoomStatus(w.deps, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    const held = expectedHold({ snapshot: w.snapshot(), forecast: w.forecast(), profile: w.profile, preferences, config: stormConfig() });
    expect(out.value.safeHours).toBe(held.hours);
    expect(out.value.safeHours).toBeLessThanOrEqual(stormConfig().capHours);
  });

  it('pre-cooled before the night, a full battery keeps grandpa within the elderly limit through the cap (#24)', async () => {
    const elderly = world(4);
    const standard = world(4);
    const deps = { ...standard.deps, comfortConfig: { ...standard.deps.comfortConfig, elderlyRoles: [] } };
    const a = await safeRoomStatus(elderly.deps, elderly.ctx);
    const b = await safeRoomStatus(deps, standard.ctx);
    if (!a.ok || !b.ok) throw new Error('status');
    // Without pre-cooling the 24 °C night limit ended his hours at 22:00, with the battery still full.
    expect(a.value.safeHours).toBe(stormConfig().capHours);
    expect(a.value.safeHours).toBeLessThanOrEqual(b.value.safeHours);
  });

  it('a safe room missing from the home profile is an error, never "safe for 24 hours" (#179 review)', async () => {
    const w = world(4);
    const base = w.deps.homes;
    const homes = (h: HomeId) => {
      const home = base(h);
      return home && { ...home, profile: { ...home.profile, rooms: home.profile.rooms.filter((r) => r.id !== 'bedroom-1') } };
    };
    const out = await safeRoomStatus({ ...w.deps, homes }, w.ctx);
    expect(!out.ok && out.error).toMatchObject({ code: 'unknown_room' });
  });

  it('without a forecast hour, says the forecast is missing rather than count (#179 review)', async () => {
    const w = world(4);
    const base = w.deps.homes;
    const homes = (h: HomeId) => {
      const home = base(h);
      return home && { ...home, forecast: () => ({ ...home.forecast(), hourly: [] }) };
    };
    const out = await safeRoomStatus({ ...w.deps, homes }, w.ctx);
    expect(!out.ok && out.error).toMatchObject({ code: 'forecast_unavailable' });
  });

  it('while preparing with the grid still up, counts the battery alone: what the storm will have', async () => {
    const w = world(1, { snapshot: (snap) => ({ ...snap, batterySocPct: pct(12) }) });
    expect(w.snapshot().gridAvailable).toBe(true);
    const out = await safeRoomStatus(w.deps, w.ctx);
    if (!out.ok) throw new Error(out.error.message);
    const held = expectedHold({ snapshot: w.snapshot(), forecast: w.forecast(), profile: w.profile, preferences, config: stormConfig() });
    expect(out.value.safeHours).toBe(held.hours);
    // With the grid counted the battery would never empty: on battery alone, 12 % does not reach the cap.
    expect(Date.parse(out.value.safeUntil)).toBeLessThan(Date.parse(w.snapshot().ts) + stormConfig().capHours * H);
  });
});
