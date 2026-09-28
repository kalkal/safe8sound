import { z } from 'zod';
import { PlanSchema, type Plan } from '../card/plan.js';
import { err, ok, type Result } from '../result.js';
import { toolError, type ToolError } from './tool-error.js';

export const PlanInputSchema = z.object({
  scenario: z.enum(['hot-day', 'storm', 'home-unreachable']).default('hot-day').describe('Spike-only switch between canned plans.'),
});

// Sample content only (plan §11.1): the real plan comes from the core + guard.
const HOT_DAY: Plan = {
  planId: 'plan-0001',
  expiresAt: '2026-09-26T12:10:00Z',
  goal: 'cool',
  until: '06:40',
  confidence: 'high',
  confidenceReason: 'Clear sky; the forecast matched the last 3 days.',
  level: 'comfort',
  levelReason: 'weather',
  reserveHours: 7.5,
  guarantees: [
    { id: 'storm_reserve', ok: true, label: 'Storm reserve', value: '6 kWh kept' },
    { id: 'pacing_on_track', ok: true, label: 'Pacing on track', value: 'lasts until 06:40' },
    { id: 'safe_room_comfort', ok: true, label: 'Safe room comfort', value: '≤ 27 °C · ≤ 60% RH' },
  ],
  dataOrigin: 'simulated',
  storm: false,
  applyAllowed: true,
};

const STORM: Plan = {
  ...HOT_DAY,
  planId: 'plan-0002',
  confidence: 'medium',
  confidenceReason: 'Grid return time is unknown.',
  level: 'essential',
  levelReason: 'storm',
  reserveHours: 10.75,
  storm: true,
  stormSince: '19:40',
  applyAllowed: false,
  applyBlockedReason: 'The guard keeps the storm reserve: nothing to apply while the grid is down.',
};

export async function planComfort(input: z.infer<typeof PlanInputSchema>): Promise<Result<Plan, ToolError>> {
  switch (input.scenario) {
    case 'hot-day':
      return ok(HOT_DAY);
    case 'storm':
      return ok(STORM);
    case 'home-unreachable':
      return err(
        toolError('home_data_stale', 'dependency_unavailable', 'The latest home reading is 20 minutes old, so no new plan was made.', {
          retryAfterMs: 60_000,
          details: { ageSeconds: 1200 },
        }),
      );
  }
}

export const PlanOutputSchema = PlanSchema;
