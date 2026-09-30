import { ApplyPlanOutputSchema, PlanIdSchema, celsius, pct, type Forecast, type Plan, type Snapshot } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyPlan } from '../../src/modules/comfort-plan/apply-plan.js';
import { planComfort } from '../../src/modules/comfort-plan/plan-comfort.js';
import { MIN, REAL, world } from './support.js';

// Mutation testing runs the properties with fewer cases (FC_RUNS); CI and local runs use the full count.
const runs = (n: number): number => Number(process.env['FC_RUNS'] ?? n);

async function proposed(w: ReturnType<typeof world>): Promise<Plan> {
  const r = await planComfort(w.deps, { goal: 'cool' }, w.ctx);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** A cold, dry spell: every forecast hour at 12 °C and 40 % outside. */
const coldSpell = (f: Forecast): Forecast => ({ ...f, hourly: f.hourly.map((h) => ({ ...h, tempOutC: celsius(12), humidityOutPct: pct(40) })) });
const roomsAt = (tempC: number, humidityPct: number) => (s: Snapshot): Snapshot => ({
  ...s,
  rooms: s.rooms.map((r) => ({ ...r, tempC: celsius(tempC), humidityPct: pct(humidityPct) })),
});

const statusOf = async (w: ReturnType<typeof world>, plan: Plan) => {
  const r = await w.store.getPlan(plan.id);
  return r.ok ? r.value.status : undefined;
};

describe('apply_plan (two-phase: confirm)', () => {
  it('applies a proposed plan once the guard revalidates it', async () => {
    const w = world('heatwave', 14);
    const plan = await proposed(w);
    const r = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    expect(r.ok && ApplyPlanOutputSchema.parse(r.value)).toMatchObject({ alreadyApplied: false, advisoryOnly: false, manualInstructions: [], plan: { id: plan.id, status: 'applied' } });
    expect(await statusOf(w, plan)).toBe('applied');
  });

  it('is idempotent by planId: a repeat returns the stored outcome', async () => {
    const w = world('heatwave', 14);
    const plan = await proposed(w);
    const first = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    const again = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    expect(again.ok && again.value.alreadyApplied).toBe(true);
    expect(again.ok && first.ok && again.value.plan).toEqual(first.ok && first.value.plan);
  });

  it('refuses an unknown plan and an expired one', async () => {
    const w = world('heatwave', 14);
    const missing = await applyPlan(w.deps, { planId: PlanIdSchema.parse('plan_nope_0000') }, w.ctx);
    expect(!missing.ok && missing.error.code).toBe('plan_not_found');
    const plan = await proposed(w);
    w.clock.set(Date.parse(plan.expiresAt) + MIN);
    const late = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    expect(!late.ok && late.error.code).toBe('plan_expired');
    expect(await statusOf(w, plan)).toBe('proposed');
  });

  it('refuses on the real home a plan built on simulated data (plan §9.4), changing nothing', async () => {
    const w = world('heatwave', 14, { homeId: REAL, readOnly: true });
    const plan = await proposed(w);
    const r = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    expect(!r.ok && r.error).toMatchObject({ code: 'simulated_plan_on_real_home', category: 'forbidden', retryable: false });
    expect(await statusOf(w, plan)).toBe('proposed');
  });

  it('on the real home with live data, stores the plan as advice and returns manual instructions per room', async () => {
    const live = { energy: 'live', rooms: 'live', weather: 'live' } as const;
    const w = world('heatwave', 14, { homeId: REAL, readOnly: true, snapshot: (s) => ({ ...s, origin: live }) });
    const plan = await proposed(w);
    const r = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    expect(r.ok && r.value.advisoryOnly).toBe(true);
    expect(r.ok && r.value.manualInstructions[0]?.text).toMatch(/^Bedroom: (cool|dry) at \d+(\.\d)? °C/);
  });

  it('refuses a plan the guard rejects on the current state, and records the rejection', async () => {
    const w = world('heatwave', 14);
    const plan = await proposed(w);
    // Meanwhile the battery ran low: the plan's own targets are now out of reach.
    w.setSnapshot((s) => ({ ...s, batterySocPct: pct(12) }));
    const r = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
    expect(!r.ok && r.error.category).toBe('guard_rejection');
    expect(await statusOf(w, plan)).toBe('proposed');
    const rejections = await w.store.listGuardRejections();
    expect(rejections.ok && rejections.value[0]?.planId).toBe(plan.id);
  });

  for (const goal of ['auto', 'heat'] as const) {
    it(`revalidates a ${goal} plan in the season it was proposed for: in the cold the heating minimum still holds`, async () => {
      const w = world('clear-day', 6, { forecast: coldSpell, snapshot: roomsAt(19, 50) });
      const planned = await planComfort(w.deps, { goal }, w.ctx);
      if (!planned.ok) throw new Error(planned.error.message);
      expect(planned.value.steps[0]?.hvacMode).toBe('heat');
      // Meanwhile a window was left open: the safe room is too cold to recover within the grace period.
      w.setSnapshot(roomsAt(3, 90));
      const r = await applyPlan(w.deps, { planId: planned.value.id }, w.ctx);
      expect(!r.ok && r.error.message).toMatch(/^The safe room would drop to [\d.]+ °C, below its 18 °C minimum\./);
      expect(await statusOf(w, planned.value)).toBe('proposed');
    });
  }

  it('property: apply_plan is idempotent, however many times it is called', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (times) => {
        const w = world('heatwave', 14);
        const plan = await proposed(w);
        const results = [];
        for (let i = 0; i < times; i++) results.push(await applyPlan(w.deps, { planId: plan.id }, w.ctx));
        const plans = results.map((r) => (r.ok ? r.value.plan : undefined));
        expect(new Set(plans.map((p) => JSON.stringify(p))).size).toBe(1);
        expect(results.filter((r) => r.ok && !r.value.alreadyApplied)).toHaveLength(1);
      }),
      { numRuns: runs(30) },
    );
  }, 120_000);

  it('property: a rejected plan never changes the stored state', async () => {
    let rejected = 0;
    await fc.assert(
      fc.asyncProperty(fc.double({ min: 10, max: 30, noNaN: true }), async (soc) => {
        const w = world('heatwave', 14);
        const plan = await proposed(w);
        const before = await w.store.getPlan(plan.id);
        w.setSnapshot((s) => ({ ...s, batterySocPct: pct(soc) }));
        const r = await applyPlan(w.deps, { planId: plan.id }, w.ctx);
        fc.pre(!r.ok);
        rejected++;
        expect(await w.store.getPlan(plan.id)).toEqual(before);
      }),
      { numRuns: runs(30) },
    );
    expect(rejected).toBeGreaterThan(0);
  }, 120_000);
});
