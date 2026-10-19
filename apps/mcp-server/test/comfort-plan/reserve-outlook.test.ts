import { CARD_TOOL_ACCESS, ReserveOutlookSchema, pct } from '@cold-reserve/contracts';
import { reserveOutlookHours } from '@cold-reserve/core';
import { reserveOf } from '@cold-reserve/guard';
import { describe, expect, it } from 'vitest';
import { comfortPlanModule } from '../../src/modules/comfort-plan/index.js';
import type { ComfortPlanDeps } from '../../src/modules/comfort-plan/deps.js';
import { reserveOutlook } from '../../src/modules/comfort-plan/reserve-outlook.js';
import { REAL, world } from './support.js';
import { localIso } from '@cold-reserve/core';

describe('get_reserve_outlook (the ice cubes)', () => {
  it('counts the hours with the guard’s reserve, at the configured level loads, valid against the contract', async () => {
    const w = world('heatwave', 14);
    const r = await reserveOutlook(w.deps, {}, w.ctx);
    if (!r.ok) throw new Error(r.error.message);
    const o = ReserveOutlookSchema.parse(r.value);
    const home = w.deps.homes(w.ctx.homeId);
    const snap = await home?.source.snapshot();
    if (home === undefined || snap === undefined || !snap.ok) throw new Error('no home');
    const reserve = reserveOf({ snapshot: snap.value, forecast: home.forecast(), profile: home.profile, model: w.deps.model, config: w.deps.guard });
    const hours = reserveOutlookHours({
      battery: home.profile.battery,
      socPct: snap.value.batterySocPct,
      gridAvailable: snap.value.gridAvailable,
      reserveFloorSocPct: reserve.reserveFloorSocPct,
      reserveWh: reserve.reserveWh,
      currentLoadW: w.deps.config.outlook.levelLoadW.comfort,
      essentialLoadW: w.deps.guard.reserve.essentialLoadW,
    });
    // The same instant as the reading, said in the home's time zone (#160).
    expect(o).toEqual({ level: 'comfort', ...hours, gridAvailable: true, origin: snap.value.origin, ts: localIso(Date.parse(snap.value.ts), w.profile.location.tz) });
  });

  it('off grid (the storm) counts down to the hardware floor', async () => {
    const w = world('storm-blackout', 3);
    const r = await reserveOutlook(w.deps, {}, w.ctx);
    expect(r.ok && r.value.hoursAtEssential).toBeGreaterThan(20);
    // The card switches to the storm theme from this, as it does for a plan (approved in #21).
    expect(r.ok && r.value.gridAvailable).toBe(false);
  });

  it('says the level the home is at during a storm, and counts its hours at that level (#444)', async () => {
    const w = world('storm-blackout', 3);
    const read = (stormLevel?: ComfortPlanDeps['stormLevel']) => reserveOutlook({ ...w.deps, ...(stormLevel === undefined ? {} : { stormLevel }) }, {}, w.ctx);
    const storm = (level: 'saver' | 'essential') => () => Promise.resolve({ level, levelReason: 'storm' as const, levelChangedAt: '2026-07-17T03:00:00+02:00' });
    const calm = await read();
    const saver = await read(storm('saver'));
    const essential = await read(storm('essential'));
    if (!calm.ok || !saver.ok || !essential.ok) throw new Error('outlook failed');
    expect(calm.value.level).toBe('comfort');
    expect(saver.value.level).toBe('saver');
    expect(essential.value.level).toBe('essential');
    // A lighter level lasts longer on the same battery; at essential the two counts are one.
    expect(saver.value.hoursAtCurrentLevel).toBeGreaterThan(calm.value.hoursAtCurrentLevel);
    expect(essential.value.hoursAtCurrentLevel).toBe(essential.value.hoursAtEssential);
    // No storm (the reader says none): the level the person chose, as before.
    const none = await read(() => Promise.resolve(undefined));
    expect(none.ok && none.value.level).toBe('comfort');
  });

  it('a battery at its hardware floor has nothing left, the storm reserve included (#273)', async () => {
    const w = world('heatwave', 14, { snapshot: (s) => ({ ...s, batterySocPct: pct(10) }) });
    const r = await reserveOutlook(w.deps, {}, w.ctx);
    expect(r.ok && r.value).toMatchObject({ hoursAtCurrentLevel: 0, hoursAtEssential: 0, reserveHoursAtEssential: 0 });
  });

  it('a home the client is not linked to is not found', async () => {
    const w = world('heatwave', 14);
    const r = await reserveOutlook(w.deps, {}, { ...w.ctx, homeId: REAL });
    expect(!r.ok && r.error.code).toBe('home_not_found');
  });
});

describe('the comfort-plan module', () => {
  it('registers plan_comfort, apply_plan and get_reserve_outlook with honest annotations', () => {
    const m = comfortPlanModule(world('heatwave', 14).deps);
    expect(m.id).toBe('comfort-plan');
    expect(m.tools.map((t) => [t.name, t.annotations.readOnlyHint, t.annotations.destructiveHint])).toEqual([
      ['plan_comfort', true, false],
      ['apply_plan', CARD_TOOL_ACCESS.apply_plan === 'read', true],
      ['get_reserve_outlook', CARD_TOOL_ACCESS.get_reserve_outlook === 'read', false],
    ]);
  });

  it('is on only for homes the server knows', () => {
    const w = world('heatwave', 14);
    const m = comfortPlanModule(w.deps);
    expect(m.enabledFor?.(w.ctx.homeId)).toBe(true);
    expect(m.enabledFor?.(REAL)).toBe(false);
  });
});
