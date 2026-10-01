import { describe, expect, it } from 'vitest';
import { examplePlan } from '../src/fixtures.js';
import { ApplyPlanInputSchema, ApplyPlanOutputSchema, ManualInstructionSchema, PlanComfortInputSchema, ReserveOutlookInputSchema, categoryOf } from '../src/index.js';

describe('comfort-plan tool I/O (approved in #19)', () => {
  it('plan_comfort takes a goal, and optionally the setpoint and the rooms the model proposes', () => {
    expect(PlanComfortInputSchema.parse({ goal: 'cool' })).toEqual({ goal: 'cool' });
    expect(PlanComfortInputSchema.safeParse({ goal: 'cool', setpointC: 22, roomIds: ['bedroom-1'] }).success).toBe(true);
    expect(PlanComfortInputSchema.safeParse({ goal: 'fan_only' }).success).toBe(false);
    expect(PlanComfortInputSchema.safeParse({ goal: 'cool', roomIds: [] }).success).toBe(false);
    expect(PlanComfortInputSchema.safeParse({ goal: 'cool', extra: 1 }).success).toBe(false);
  });

  it('apply_plan takes a plan id only', () => {
    expect(ApplyPlanInputSchema.safeParse({ planId: 'plan_7Hq2mX9vK3' }).success).toBe(true);
    expect(ApplyPlanInputSchema.safeParse({ planId: 'x' }).success).toBe(false);
  });

  it('get_reserve_outlook takes nothing', () => {
    expect(ReserveOutlookInputSchema.safeParse({}).success).toBe(true);
    expect(ReserveOutlookInputSchema.safeParse({ homeId: 'demo' }).success).toBe(false);
  });

  it('apply_plan returns the stored plan, whether it was already applied, and manual steps when advisory', () => {
    const plan = { ...examplePlan(), status: 'applied' };
    const out = { plan, alreadyApplied: false, advisoryOnly: true, manualInstructions: [{ roomId: 'bedroom-1', text: 'Bedroom: dry at 26.5 °C, fan on' }] };
    expect(ApplyPlanOutputSchema.parse(out).plan.status).toBe('applied');
    expect(ManualInstructionSchema.safeParse({ roomId: 'bedroom-1', text: '' }).success).toBe(false);
  });

  it('manual instructions come only with advice', () => {
    const plan = { ...examplePlan(), status: 'applied' };
    const out = { plan, alreadyApplied: false, advisoryOnly: false, manualInstructions: [{ roomId: 'bedroom-1', text: 'Bedroom: cool at 25 °C' }] };
    expect(ApplyPlanOutputSchema.safeParse(out).success).toBe(false);
    expect(ApplyPlanOutputSchema.safeParse({ ...out, manualInstructions: [] }).success).toBe(true);
  });

  it('a storm calculation on a home without its EPS load is refused, never assumed (#107)', () => {
    expect(categoryOf('missing_eps_load')).toBe('internal');
  });

  it('a simulated plan on the real home is forbidden', () => {
    expect(categoryOf('simulated_plan_on_real_home')).toBe('forbidden');
  });
});
