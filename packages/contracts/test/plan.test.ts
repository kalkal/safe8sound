import { describe, expect, it } from 'vitest';
import { examplePlan } from '../src/fixtures.js';
import { FAMILY_GUARANTEES, GUARANTEE_IDS, GuaranteeResultSchema, PlanSchema } from '../src/index.js';

describe('guarantees', () => {
  it('has exactly the five guarantees of plan §3.1', () => {
    expect(GUARANTEE_IDS).toEqual(['storm_reserve', 'inverter_limit', 'battery_power', 'safe_room_comfort', 'pacing_on_track']);
  });

  it('shows three of them to the family', () => {
    expect(FAMILY_GUARANTEES).toEqual(['storm_reserve', 'pacing_on_track', 'safe_room_comfort']);
  });

  it('reports ok, a reason and optionally the limit and the nearest allowed value', () => {
    const result = { id: 'inverter_limit', ok: false, reason: 'Three splits need 5.4 kW.', limit: 5000, nearestAllowed: 4800, unit: 'W' };
    expect(GuaranteeResultSchema.safeParse(result).success).toBe(true);
    expect(GuaranteeResultSchema.safeParse({ ...result, reason: '' }).success).toBe(false);
    expect(GuaranteeResultSchema.safeParse({ ...result, unit: 'kW' }).success).toBe(false);
  });
});

describe('PlanSchema', () => {
  it('parses the example plan', () => {
    const plan = PlanSchema.parse(examplePlan());
    expect(plan.status).toBe('proposed');
    expect(plan.guarantees.map((g) => g.id).sort()).toEqual([...GUARANTEE_IDS].sort());
  });

  it('requires every guarantee exactly once', () => {
    const input = examplePlan();
    expect(PlanSchema.safeParse({ ...input, guarantees: input.guarantees.slice(1) }).success).toBe(false);
    const first = input.guarantees[0];
    if (!first) throw new Error('fixture has guarantees');
    expect(PlanSchema.safeParse({ ...input, guarantees: [...input.guarantees.slice(1), first, first] }).success).toBe(false);
  });

  it('expires after it was created', () => {
    const input = examplePlan();
    expect(PlanSchema.safeParse({ ...input, expiresAt: input.createdAt }).success).toBe(false);
  });

  it('keeps the ladder in order from comfort down, without repeats', () => {
    const input = examplePlan();
    expect(PlanSchema.safeParse({ ...input, ladder: [...input.ladder].reverse() }).success).toBe(false);
  });

  it('only uses levels that are in its ladder', () => {
    const input = examplePlan();
    const step = input.steps[0];
    if (!step) throw new Error('fixture has steps');
    const ladder = input.ladder.filter((l) => l.level !== 'essential');
    expect(PlanSchema.safeParse({ ...input, ladder, steps: [{ ...step, level: 'essential' }] }).success).toBe(false);
  });

  it('accepts only the comfort goals', () => {
    expect(PlanSchema.safeParse({ ...examplePlan(), goal: 'fan_only' }).success).toBe(false);
  });

  it('carries the forecast confidence and the data origin', () => {
    const plan = PlanSchema.parse(examplePlan());
    expect(plan.forecastConfidence).toBe('high');
    expect(plan.sourceOrigin.energy).toBe('simulated');
  });
});
