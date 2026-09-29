import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';

// Guard thresholds: config, never constants in code (project rules). Defaults in ../config/guard.json.

const positive = z.number().positive();
const nonNegative = z.number().nonnegative();
const hour = z.number().int().min(0).max(23);

export const GuardConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /**
   * Base load (everything but HVAC and fans) by local hour, 0-23: a typical household day, to calibrate on
   * the real plant. A flat value underestimates the evening peak and makes the pacing optimistic.
   */
  projection: z.strictObject({ stepMinutes: positive.max(60), baseLoadWByLocalHour: z.array(nonNegative).length(24) }),
  /** Storm reserve: the essential load (safe room + router + fridge) through the dark hours, up to a cap. */
  reserve: z.strictObject({ essentialLoadW: positive, capWh: nonNegative }),
  /** Pacing (plan §4bis): the projection may fall this far below the plan's trajectory; level hysteresis. */
  pacing: z.strictObject({
    trackTolerancePct: nonNegative,
    downMarginPct: nonNegative,
    upMarginPct: nonNegative,
    maxChangesPerHour: z.number().int().positive(),
    minDwellMinutes: nonNegative,
  }),
  /** Time a plan gets to bring the safe room inside its thresholds. */
  safeRoom: z.strictObject({ graceMinutes: nonNegative }),
  /** Night recovery (feature queue item 1): sources in packages/contracts/src/night-recovery.ts. */
  nightRecovery: z
    .strictObject({
      windowStartHour: hour,
      windowEndHour: hour,
      thresholdC: z.strictObject({ standard: z.number().min(18).max(30), elderly: z.number().min(18).max(30) }),
      requiredHours: nonNegative.max(24),
      heatIndexBaseC: z.number(),
      budgetDegreeHours: nonNegative,
      /** The reference strategy that decides feasibility cools this far below the threshold. */
      referenceSetpointMarginK: nonNegative.max(5),
    })
    .refine((n) => n.thresholdC.elderly <= n.thresholdC.standard, {
      path: ['thresholdC', 'elderly'],
      message: 'The elderly threshold is at most the standard one',
    }),
});
export type GuardConfig = z.infer<typeof GuardConfigSchema>;

export function parseGuardConfig(raw: unknown): Result<GuardConfig, ErrorEnvelope> {
  const parsed = GuardConfigSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.').slice(0, 120), message: i.message.slice(0, 200) }));
  return err(toolError('invalid_config', 'The guard configuration is not valid.', { details: { issues } }));
}
