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

  describe('the two-step confirmation of a last-resort plan (approved in #160)', () => {
    const lastResortPlan = () => ({
      ...examplePlan(),
      guarantees: examplePlan().guarantees.map((g) => (g.id === 'safe_room_comfort' ? { ...g, ok: false, reason: 'Above 27 °C after 02:40.' } : g)),
      lastResort: { safeUntil: '2026-07-18T00:40:00.000Z', safeHours: 4.5, limitedBy: 'temperature' },
      warnings: [{ code: 'last_resort_plan', message: 'Under 26 °C until 02:40, then up to 29 °C by 07:00.' }],
    });
    const token = 'lr_' + 'A'.repeat(22);

    it('apply_plan may carry the token of the first step', () => {
      expect(ApplyPlanInputSchema.safeParse({ planId: 'plan_7Hq2mX9vK3', lastResortToken: token }).success).toBe(true);
      expect(ApplyPlanInputSchema.safeParse({ planId: 'plan_7Hq2mX9vK3', lastResortToken: 'yes' }).success).toBe(false);
      expect(ApplyPlanInputSchema.safeParse({ planId: 'plan_7Hq2mX9vK3', lastResortToken: 'lr_' + 'A'.repeat(65) }).success).toBe(false);
    });

    it('the first step returns the plan still proposed, with a token and when it expires', () => {
      const out = { plan: lastResortPlan(), alreadyApplied: false, advisoryOnly: false, manualInstructions: [], confirmation: { token, expiresAt: '2026-07-17T20:10:00.000Z' } };
      expect(ApplyPlanOutputSchema.parse(out).confirmation?.token).toBe(token);
    });

    it('a confirmation comes only with a last-resort plan that is not applied yet', () => {
      const confirmation = { token, expiresAt: '2026-07-17T20:10:00.000Z' };
      const applied = { plan: { ...lastResortPlan(), status: 'applied' }, alreadyApplied: false, advisoryOnly: false, manualInstructions: [], confirmation };
      expect(ApplyPlanOutputSchema.safeParse(applied).success).toBe(false);
      const normal = { plan: examplePlan(), alreadyApplied: false, advisoryOnly: false, manualInstructions: [], confirmation };
      expect(ApplyPlanOutputSchema.safeParse(normal).success).toBe(false);
    });

    it('says how the family alert went when a last resort is applied: sent and failed, whole numbers (#170)', () => {
      const applied = { plan: { ...lastResortPlan(), status: 'applied' }, alreadyApplied: false, advisoryOnly: false, manualInstructions: [] };
      expect(ApplyPlanOutputSchema.parse({ ...applied, familyAlert: { sent: 1, failed: 0 } }).familyAlert).toEqual({ sent: 1, failed: 0 });
      expect(ApplyPlanOutputSchema.safeParse({ ...applied, familyAlert: { sent: -1, failed: 0 } }).success).toBe(false);
      expect(ApplyPlanOutputSchema.safeParse({ ...applied, familyAlert: { sent: 1.5, failed: 0 } }).success).toBe(false);
      const r = ApplyPlanOutputSchema.safeParse({ ...applied, plan: { ...examplePlan(), status: 'applied' }, familyAlert: { sent: 1, failed: 0 } });
      expect(!r.success && r.error.issues[0]?.path).toEqual(['familyAlert']);
    });

    it('a wrong, stale or reused token is a validation error', () => {
      expect(categoryOf('last_resort_token_invalid')).toBe('validation');
    });
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
