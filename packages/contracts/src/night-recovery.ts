import { z } from 'zod';
import { EntityIdSchema, IsoDateTimeSchema, epochMs } from './common.js';
import { CelsiusSchema } from './units.js';

// Night recovery of the safe/bed room (feature queue item 1, approved by the maintainer on 2026-09-28).
// It is a comfort-for-sleep metric, not a medical outcome: we never claim it prevents illness.

/**
 * `standard` uses the CIBSE TM59 night threshold for bedrooms (26 °C, 22:00–07:00).
 * `elderly` uses 24 °C: in older adults (median age 72) the risk of reduced overnight heart-rate
 * variability recovery grows with bedroom temperature above 24 °C (x1.4 at 24–26 °C, x2.0 at 26–28 °C);
 * the authors recommend at most 24 °C (https://pmc.ncbi.nlm.nih.gov/articles/PMC12751657/).
 */
export const NightRecoveryModeSchema = z.enum(['standard', 'elderly']);
export type NightRecoveryMode = z.infer<typeof NightRecoveryModeSchema>;

/**
 * `met`: the plan keeps the room at or below the threshold for the required hours, within the heat budget.
 * `unmet`: the target was reachable but the plan misses it; the guard rejects the plan.
 * `infeasible`: no strategy the battery allows reaches it; the plan is not rejected, the result says so
 * honestly with the best achievable hours, and the plan carries a `night_recovery_infeasible` warning.
 */
export const NightRecoveryStatusSchema = z.enum(['met', 'unmet', 'infeasible']);
export type NightRecoveryStatus = z.infer<typeof NightRecoveryStatusSchema>;

const hours = z.number().nonnegative();

export const NightRecoverySchema = z
  .strictObject({
    roomId: EntityIdSchema,
    mode: NightRecoveryModeSchema,
    /** Air temperature the room must stay at or below: 26 °C (TM59) or 24 °C (elderly, PMC12751657). */
    thresholdC: CelsiusSchema,
    /**
     * The night window evaluated, 22:00–07:00 local time (CIBSE TM59 bedroom night hours), cut to the
     * part the projection covers.
     */
    window: z
      .strictObject({ start: IsoDateTimeSchema, end: IsoDateTimeSchema })
      .refine((w) => epochMs(w.start) < epochMs(w.end), { message: 'The window ends after it starts' }),
    /** At least this many hours at or below the threshold (config, capped by the window length). */
    requiredHours: hours,
    /** Hours at or below the threshold with this plan. */
    achievedHours: hours,
    status: NightRecoveryStatusSchema,
    /** Present only when infeasible: the most hours any strategy the battery allows can reach. */
    bestAchievableHours: hours.optional(),
    /**
     * Heat Index degree-hours above 26.7 °C (80 °F, where the NOAA heat index starts and the
     * "caution" band of the EnergyPlus resilience metrics begins) inside the window:
     * sum of max(0, HI - 26.7) x hours
     * (https://bigladdersoftware.com/epx/docs/24-1/engineering-reference/resilience-metrics.html).
     */
    heatIndexDegreeHoursAbove26_7: hours,
    /** The heat budget for the night, in the same unit (config). */
    budgetDegreeHours: hours,
  })
  .refine((n) => (n.status === 'infeasible') === (n.bestAchievableHours !== undefined), {
    path: ['bestAchievableHours'],
    message: 'Best achievable hours are given exactly when the target is infeasible',
  });
export type NightRecovery = z.infer<typeof NightRecoverySchema>;

/** Things the voice and the cards must say even when the plan is accepted. */
export const PlanWarningCodeSchema = z.enum(['night_recovery_infeasible']);
export type PlanWarningCode = z.infer<typeof PlanWarningCodeSchema>;

export const PlanWarningSchema = z.strictObject({
  code: PlanWarningCodeSchema,
  /** Short English sentence, with the numbers. */
  message: z.string().min(1).max(300),
});
export type PlanWarning = z.infer<typeof PlanWarningSchema>;
