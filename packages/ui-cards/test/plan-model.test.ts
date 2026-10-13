import { describe, expect, it } from 'vitest';
import { celsius } from '@cold-reserve/contracts';
import { hotDayPlan } from '../src/fixtures.js';
import { homeClock, lastResortHeadline, levelSpans, pacingGeometry } from '../src/plan-model.js';

const TZ = 'Europe/Rome';

describe('homeClock', () => {
  it("shows the home's own clock, whatever offset the timestamp carries", () => {
    expect(homeClock('2026-07-16T05:00:00Z', TZ)).toBe('07:00');
    expect(homeClock('2026-07-16T07:00:00+02:00', TZ)).toBe('07:00');
    expect(homeClock('2026-01-16T06:00:00Z', TZ)).toBe('07:00');
  });
});

describe('levelSpans (the level ribbon)', () => {
  it('gives every rung of the ladder its time span, in home time, until the horizon', () => {
    expect(levelSpans(hotDayPlan(), TZ)).toEqual([
      { level: 'comfort', from: '15:00', to: '19:00', current: true },
      { level: 'balanced', from: '19:00', to: '23:00', current: false },
      { level: 'saver', from: '23:00', to: '07:00', current: false },
      { level: 'essential', from: null, to: null, current: false },
    ]);
  });

  it('marks a level that returns later with its first span only, never twice', () => {
    const plan = hotDayPlan();
    const back = plan.steps[4];
    if (back) plan.steps[4] = { ...back, level: 'balanced' };
    const spans = levelSpans(plan, TZ);
    expect(spans.filter((s) => s.level === 'balanced')).toHaveLength(1);
    expect(spans.find((s) => s.level === 'balanced')).toMatchObject({ from: '19:00', to: '23:00' });
  });

  it('shows every rung as not needed when the plan has no steps', () => {
    const spans = levelSpans({ ...hotDayPlan(), steps: [] }, TZ);
    expect(spans.every((s) => s.from === null && !s.current)).toBe(true);
  });
});

describe('pacingGeometry (expected charge until the horizon)', () => {
  it('places one point per step on a 0–100 time axis, with the charge as height', () => {
    const { points } = pacingGeometry(hotDayPlan(), 13_800);
    expect(points).toHaveLength(6);
    expect(points[0]?.x).toBeCloseTo(5.88, 2);
    expect(points[0]?.y).toBe(20);
    expect(points.at(-1)?.x).toBeCloseTo(98.04, 2);
    expect(points.at(-1)?.y).toBe(54);
    expect(points.every((p, i) => i === 0 || p.x > (points[i - 1]?.x ?? 0))).toBe(true);
  });

  it("draws the storm reserve floor from the guard's SOC floor, same axis as the charge", () => {
    expect(pacingGeometry(hotDayPlan()).floorPct).toBe(43);
    expect(pacingGeometry({ ...hotDayPlan(), reserveFloorSocPct: undefined }, 13_800).floorPct).toBe(43);
    expect(pacingGeometry({ ...hotDayPlan(), reserveFloorSocPct: undefined }).floorPct).toBeUndefined();
  });

  it('never divides by zero when the horizon equals the creation time', () => {
    const plan = hotDayPlan();
    const { points } = pacingGeometry({ ...plan, horizonAt: plan.createdAt });
    expect(points.every((p) => Number.isFinite(p.x) && p.x >= 0 && p.x <= 100)).toBe(true);
  });
});

describe('lastResortHeadline (#364): the big time of a last resort', () => {
  const base = { safeUntil: '2026-07-16T03:05:00+02:00', safeHours: 7.2, limitedBy: 'battery' as const };
  const horizonAt = '2026-07-16T08:00:00+02:00';

  it('the battery runs out first and the room crosses its limit later: that crossing, with its limit', () => {
    const lr = { ...base, comfortLimitC: celsius(24), worstC: celsius(26.1), worstAt: '2026-07-16T07:00:00+02:00', limitCrossedAt: '2026-07-16T06:00:00+02:00', limitCrossedC: celsius(24) };
    expect(lastResortHeadline(lr, horizonAt)).toEqual({ kind: 'under', at: '2026-07-16T06:00:00+02:00', limitC: 24 });
    // The limit crossed there, not the one at the worst point.
    expect(lastResortHeadline({ ...lr, comfortLimitC: celsius(26) }, horizonAt)).toMatchObject({ limitC: 24 });
  });

  it('the battery runs out and the room stays inside its limits to the next recharge: the recharge, "at least"', () => {
    expect(lastResortHeadline(base, horizonAt)).toEqual({ kind: 'within', at: horizonAt });
  });

  it('otherwise the end of the safe hours, said as the battery or as the limits', () => {
    const window = { comfortLimitC: celsius(24), worstC: celsius(26.1), worstAt: '2026-07-16T07:00:00+02:00' };
    expect(lastResortHeadline({ ...base, ...window }, horizonAt)).toEqual({ kind: 'battery', at: base.safeUntil });
    expect(lastResortHeadline({ ...base, ...window, limitedBy: 'temperature' }, horizonAt)).toEqual({ kind: 'limits', at: base.safeUntil });
    expect(lastResortHeadline({ ...base, limitedBy: 'humidity' }, horizonAt)).toEqual({ kind: 'limits', at: base.safeUntil });
  });

  it('never earlier than the battery time', () => {
    const lr = { ...base, comfortLimitC: celsius(24), worstC: celsius(26.1), worstAt: '2026-07-16T07:00:00+02:00', limitCrossedAt: '2026-07-16T06:00:00+02:00', limitCrossedC: celsius(24) };
    for (const l of [base, lr, { ...base, limitedBy: 'temperature' as const }]) expect(Date.parse(lastResortHeadline(l, horizonAt).at)).toBeGreaterThanOrEqual(Date.parse(base.safeUntil));
  });
});

describe('lastResortHeadline when heating (#364 review): the room gets colder, never "under" its minimum', () => {
  it('a crossing below the heating minimum keeps the battery time big, said as the battery', () => {
    const lr = {
      safeUntil: '2026-01-16T03:05:00+01:00',
      safeHours: 7.2,
      limitedBy: 'battery' as const,
      comfortLimitC: celsius(18),
      worstC: celsius(16.5),
      worstAt: '2026-01-16T07:00:00+01:00',
      limitCrossedAt: '2026-01-16T06:00:00+01:00',
      limitCrossedC: celsius(18),
    };
    expect(lastResortHeadline(lr, '2026-01-16T08:00:00+01:00')).toEqual({ kind: 'battery', at: lr.safeUntil });
  });
});
