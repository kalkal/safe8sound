import { describe, expect, it } from 'vitest';
import { hotDayPlan } from '../src/fixtures.js';
import { homeClock, levelSpans, pacingGeometry } from '../src/plan-model.js';

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

  it('draws the storm reserve floor only when the battery size is known', () => {
    expect(pacingGeometry(hotDayPlan(), 13_800).floorPct).toBe(43);
    expect(pacingGeometry(hotDayPlan()).floorPct).toBeUndefined();
  });

  it('never divides by zero when the horizon equals the creation time', () => {
    const plan = hotDayPlan();
    const { points } = pacingGeometry({ ...plan, horizonAt: plan.createdAt });
    expect(points.every((p) => Number.isFinite(p.x) && p.x >= 0 && p.x <= 100)).toBe(true);
  });
});
