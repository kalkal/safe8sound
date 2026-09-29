import { describe, expect, it } from 'vitest';
import { examplePlan } from '../src/fixtures.js';
import { CounterfactualSchema, PlanSchema } from '../src/index.js';

const line = (peakTempC: number, peakAt: string, heatIndexDegreeHours: number, hoursAtOrBelowThreshold: number) => ({
  peakTempC,
  peakAt,
  heatIndexDegreeHours,
  hoursAtOrBelowThreshold,
});

const counterfactual = {
  roomId: 'bedroom-1',
  scenarios: {
    noPlan: line(31.2, '2026-07-16T01:00:00.000Z', 21.5, 0),
    naive: line(30.1, '2026-07-16T03:00:00.000Z', 12, 3),
    plan: line(26.4, '2026-07-15T20:00:00.000Z', 0.3, 8.5),
  },
};

describe('CounterfactualSchema (feature queue item 2)', () => {
  it('parses the three lines: no plan, the naive plan and ours', () => {
    expect(CounterfactualSchema.parse(counterfactual).scenarios.noPlan.peakTempC).toBe(31.2);
  });

  it('needs all three lines', () => {
    expect(CounterfactualSchema.safeParse({ ...counterfactual, scenarios: { ...counterfactual.scenarios, naive: undefined } }).success).toBe(false);
  });

  it('rejects negative hours and degree-hours', () => {
    const bad = { ...counterfactual, scenarios: { ...counterfactual.scenarios, plan: line(26, '2026-07-15T20:00:00.000Z', -1, 2) } };
    expect(CounterfactualSchema.safeParse(bad).success).toBe(false);
  });

  it('is optional on a plan (backward-compatible)', () => {
    expect(PlanSchema.parse(examplePlan()).counterfactual).toBeUndefined();
    expect(PlanSchema.parse({ ...examplePlan(), counterfactual }).counterfactual?.roomId).toBe('bedroom-1');
  });
});
