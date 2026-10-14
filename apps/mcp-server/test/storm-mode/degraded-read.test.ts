import { celsius, err, pct, toolError } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import type { StormModeDeps } from '../../src/modules/storm-mode/deps.js';
import { safeRoomSummary } from '../../src/modules/storm-mode/summaries.js';
import { safeRoomStatus, startStormMode } from '../../src/modules/storm-mode/tools.js';
import { world, type WorldOptions } from './support.js';

// #114: when the store cannot be reached, the safe room status is still read (live reading, default safe room, no
// storm session), at the stricter night limit, flagged and logged; the writes stay fail-closed.

const unreachable = () => toolError('store_unavailable', 'The saved settings are not reachable right now; try again shortly.');
const storeDown = (deps: StormModeDeps): StormModeDeps => ({ ...deps, preferencesFor: () => Promise.resolve(err(unreachable())) });
const sessionDown = (deps: StormModeDeps): StormModeDeps => ({
  ...deps,
  storeFor: (homeId, scope) => ({ ...deps.storeFor(homeId, scope), getLatestStormSession: () => Promise.resolve(err(unreachable())) }),
});
// Nobody older in the safe room: the normal reading plays the standard night limit (26 °C).
// A heatwave evening on a low battery, so the hold ends before its cap and the night limit counts.
const youngOnly: WorldOptions = { snapshot: (s) => ({ ...s, batterySocPct: pct(25), rooms: s.rooms.map((r) => ({ ...r, occupants: ['daughter'] })) }) };

describe('get_safe_room_status with the store down (#114)', () => {
  it('answers the live reading, flagged, at the older-person night limit, and logs one warn line', async () => {
    const w = world(20, youngOnly, 'heatwave');
    const normal = await safeRoomStatus(w.deps, w.ctx);
    if (!normal.ok) throw new Error(normal.error.message);
    const degraded = await safeRoomStatus(storeDown(w.deps), w.ctx);
    if (!degraded.ok) throw new Error(degraded.error.message);
    expect(normal.value.storeUnavailable).toBeUndefined();
    expect(degraded.value).toMatchObject({ storeUnavailable: true, stricterNightLimit: true, safeRoomId: normal.value.safeRoomId, tempC: normal.value.tempC });
    expect(normal.value.stricterNightLimit).toBeUndefined();
    // The stricter night limit (24 °C) never gives more hours than the standard one.
    expect(degraded.value.safeHours).toBeLessThan(normal.value.safeHours);
    const degradedLines = w.logs.filter((l) => l.message === 'storm_read_degraded');
    expect(degradedLines).toMatchObject([{ level: 'warn', correlationId: 'test-correlation', code: 'store_unavailable', details: { event: 'storm_read_degraded', unreachable: 'preferences' } }]);
    // #344: what could not be read, never the sandbox id or a key; the code is the line's own `code`, and the cause's
    // name is on the store's onError line with the same correlation id.
    expect(Object.keys(degradedLines[0]?.details ?? {}).sort()).toEqual(['event', 'unreachable']);
    const text = safeRoomSummary(degraded.value);
    expect(text).toMatch(/^The saved settings and the storm state are not reachable right now: this is the live reading only\. /);
    expect(text).toContain('on the battery alone, at the stricter night limit for an older person, it would hold about');
    expect(text).not.toContain('Safe for about');
    expect(text).toContain('Storm mode could not be checked.');
  });

  it('#342: with the grid down, the sentence gives the hours and the time at the stricter older-person night limit', async () => {
    const w = world(4);
    const degraded = await safeRoomStatus(storeDown(w.deps), w.ctx);
    if (!degraded.ok) throw new Error(degraded.error.message);
    expect(degraded.value.gridAvailable).toBe(false);
    const text = safeRoomSummary(degraded.value);
    expect(text).toMatch(/ At the stricter night limit for an older person, it holds for about [\d.]+ hours, until \d{1,2}:\d\d(?: [AP]M)?(?: tomorrow)?\. /);
    expect(text).not.toContain('Safe for about');
    expect(text).not.toContain('The grid powers the safe room');
  });

  it('#342: in the heating season the older-person night limit changes nothing, so the reading says the live hours plainly', async () => {
    const w = world(4);
    // A cold week: the forecast never gets above the heating comfort, so the hold keeps the heating minimum.
    const cold: StormModeDeps = {
      ...w.deps,
      homes: (h) => {
        const home = w.deps.homes(h);
        return home && { ...home, forecast: () => ({ ...home.forecast(), hourly: home.forecast().hourly.map((x) => ({ ...x, tempOutC: celsius(5) })) }) };
      },
    };
    const degraded = await safeRoomStatus(storeDown(cold), w.ctx);
    if (!degraded.ok) throw new Error(degraded.error.message);
    expect(degraded.value.storeUnavailable).toBe(true);
    expect(degraded.value.stricterNightLimit).toBeUndefined();
    const text = safeRoomSummary(degraded.value);
    expect(text).not.toMatch(/stricter|older person/);
    expect(text).toMatch(/ From the live reading, it holds for about [\d.]+ hours, until \d{1,2}:\d\d(?: [AP]M)?(?: tomorrow)?\. /);
    const gridUp = safeRoomSummary({ ...degraded.value, gridAvailable: true });
    expect(gridUp).toContain('The grid powers the safe room; on the battery alone it would hold about');
    expect(gridUp).not.toMatch(/stricter|older person/);
  });

  it('#344: in a neutral season (neither cooling nor heating) the hours are at the stricter older-person night limit', async () => {
    const w = world(4);
    const prefs = w.deps.defaultPreferencesFor(w.ctx.homeId, w.profile);
    if (!prefs.ok) throw new Error(prefs.error.message);
    // A mild week: the forecast stays strictly between the heating and the cooling comfort.
    const mild = celsius((prefs.value.comfortC.heating + prefs.value.comfortC.cooling) / 2);
    const neutral: StormModeDeps = {
      ...w.deps,
      homes: (h) => {
        const home = w.deps.homes(h);
        return home && { ...home, forecast: () => ({ ...home.forecast(), hourly: home.forecast().hourly.map((x) => ({ ...x, tempOutC: mild })) }) };
      },
    };
    const degraded = await safeRoomStatus(storeDown(neutral), w.ctx);
    if (!degraded.ok) throw new Error(degraded.error.message);
    expect(degraded.value).toMatchObject({ storeUnavailable: true, stricterNightLimit: true });
    expect(safeRoomSummary(degraded.value)).toContain('stricter night limit for an older person');
  });

  it('a storm session that cannot be read: the reading still comes, without a storm phase', async () => {
    const w = world(4);
    await startStormMode(w.deps, { mode: 'active' }, w.ctx);
    const degraded = await safeRoomStatus(sessionDown(w.deps), w.ctx);
    if (!degraded.ok) throw new Error(degraded.error.message);
    expect(degraded.value.storeUnavailable).toBe(true);
    expect(degraded.value.stormPhase).toBeUndefined();
  });

  it('keeps the sandbox unit: a °F sandbox reads °F, never a silent °C', async () => {
    const w = world(20, { units: 'F' });
    const degraded = await safeRoomStatus(storeDown(w.deps), w.ctx);
    if (!degraded.ok) throw new Error(degraded.error.message);
    const text = safeRoomSummary(degraded.value, w.deps.homes(w.ctx.homeId)?.units);
    expect(text).toContain('°F');
    expect(text).not.toContain('°C');
  });

  it('only a store that cannot be reached degrades; any other failure, and every write, stays an error', async () => {
    const w = world(4);
    const broken = { ...w.deps, preferencesFor: () => Promise.resolve(err(toolError('unexpected_error', 'A stored record does not match its schema.'))) };
    expect(await safeRoomStatus(broken, w.ctx)).toMatchObject({ ok: false, error: { code: 'unexpected_error' } });
    expect(await startStormMode(storeDown(w.deps), { mode: 'prepare' }, w.ctx)).toMatchObject({ ok: false, error: { code: 'store_unavailable' } });
  });
});
