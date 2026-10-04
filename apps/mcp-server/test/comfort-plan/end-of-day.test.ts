import { PlanSchema, type Forecast } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { applyPlan } from '../../src/modules/comfort-plan/apply-plan.js';
import { planComfort } from '../../src/modules/comfort-plan/plan-comfort.js';
import { reserveOutlook } from '../../src/modules/comfort-plan/reserve-outlook.js';
import { world } from './support.js';

// #238: in the last hour of a scenario day the forecast ran out and the projection threw (unexpected_error). With the
// daily anchor on AWS that was every night. A forecast without hours is a typed error, never a throw; and the
// simulator's forecast goes on into the next replay of the day, so plans work up to midnight.

describe('a forecast without hours (#238)', () => {
  const empty = { forecast: (f: Forecast): Forecast => ({ ...f, hourly: [] }) };

  it('plan_comfort, apply_plan and get_reserve_outlook answer forecast_unavailable instead of throwing', async () => {
    const ok = world('clear-day', 12);
    const made = await planComfort(ok.deps, { goal: 'cool' }, ok.ctx);
    if (!made.ok) throw new Error(made.error.message);

    const w = world('clear-day', 12, empty);
    expect(await planComfort(w.deps, { goal: 'cool' }, w.ctx)).toMatchObject({ ok: false, error: { code: 'forecast_unavailable', category: 'dependency_unavailable' } });
    expect(await reserveOutlook(w.deps, {}, w.ctx)).toMatchObject({ ok: false, error: { code: 'forecast_unavailable' } });
    await w.store.savePlan(made.value);
    expect(await applyPlan(w.deps, { planId: made.value.id }, w.ctx)).toMatchObject({ ok: false, error: { code: 'forecast_unavailable' } });
  });
});

describe('the last hour of a scenario day (#238)', () => {
  // The forecast keeps the day's last hour and the projection holds it: every answer is a plan or a typed error
  // (a guard refusal is a real answer), never a throw. At 23:30 the clear day still plans and applies.
  it('plans and applies at 23:30', async () => {
    const w = world('clear-day', 23.5);
    const made = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    const plan = PlanSchema.parse(made.ok ? made.value : undefined);
    expect((await applyPlan(w.deps, { planId: plan.id }, w.ctx)).ok).toBe(true);
  });

  it.each([23.5, 23.9, 23.99])('at hour %s plan, apply and outlook answer, never unexpected_error', async (h) => {
    const w = world('clear-day', h);
    const made = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
    expect(made.ok || made.error.code !== 'unexpected_error').toBe(true);
    expect((await reserveOutlook(w.deps, {}, w.ctx)).ok).toBe(true);
    if (made.ok) {
      const applied = await applyPlan(w.deps, { planId: made.value.id }, w.ctx);
      expect(applied.ok || applied.error.code !== 'unexpected_error').toBe(true);
    }
  });
});
