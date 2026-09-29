import { describe, expect, it } from 'vitest';
import { examplePlan } from '../src/fixtures.js';
import { NightRecoverySchema, PlanSchema, PlanWarningSchema, categoryOf } from '../src/index.js';

const met = {
  roomId: 'bedroom-1',
  mode: 'standard',
  thresholdC: 26,
  window: { start: '2026-07-15T22:00:00+02:00', end: '2026-07-16T07:00:00+02:00' },
  requiredHours: 6,
  achievedHours: 8.5,
  status: 'met',
  heatIndexDegreeHoursAbove26_7: 0.4,
  budgetDegreeHours: 2,
} as const;

const infeasible = { ...met, achievedHours: 2, status: 'infeasible', bestAchievableHours: 3.5 } as const;
const warning = { code: 'night_recovery_infeasible', message: 'The battery can keep the bedroom at 26 C for 3.5 hours tonight, not 6.' } as const;

describe('NightRecoverySchema', () => {
  it('parses a met night-recovery result', () => {
    expect(NightRecoverySchema.parse(met).status).toBe('met');
  });

  it('has an elderly mode next to the standard one', () => {
    expect(NightRecoverySchema.safeParse({ ...met, mode: 'elderly', thresholdC: 24 }).success).toBe(true);
    expect(NightRecoverySchema.safeParse({ ...met, mode: 'child' }).success).toBe(false);
  });

  it('requires the best achievable hours when the target is infeasible, and only then', () => {
    expect(NightRecoverySchema.safeParse(infeasible).success).toBe(true);
    expect(NightRecoverySchema.safeParse({ ...infeasible, bestAchievableHours: undefined }).success).toBe(false);
    expect(NightRecoverySchema.safeParse({ ...met, bestAchievableHours: 7 }).success).toBe(false);
  });

  it('rejects negative hours and a window that ends before it starts', () => {
    expect(NightRecoverySchema.safeParse({ ...met, achievedHours: -1 }).success).toBe(false);
    expect(NightRecoverySchema.safeParse({ ...met, window: { start: met.window.end, end: met.window.start } }).success).toBe(false);
  });
});

describe('Plan with night recovery and warnings (optional, backward-compatible)', () => {
  it('still parses a plan without them', () => {
    const plan = PlanSchema.parse(examplePlan());
    expect(plan.nightRecovery).toBeUndefined();
    expect(plan.warnings).toBeUndefined();
  });

  it('parses a plan with a met night recovery', () => {
    expect(PlanSchema.parse({ ...examplePlan(), nightRecovery: met }).nightRecovery?.achievedHours).toBe(8.5);
  });

  it('cannot hide an infeasible night: the warning must be there', () => {
    expect(PlanSchema.safeParse({ ...examplePlan(), nightRecovery: infeasible }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...examplePlan(), nightRecovery: infeasible, warnings: [warning] }).success).toBe(true);
  });

  it('accepts only known warning codes', () => {
    expect(PlanWarningSchema.safeParse(warning).success).toBe(true);
    expect(PlanWarningSchema.safeParse({ ...warning, code: 'something_else' }).success).toBe(false);
  });
});

describe('night_recovery_unmet error code', () => {
  it('is a guard rejection', () => {
    expect(categoryOf('night_recovery_unmet')).toBe('guard_rejection');
  });
});
