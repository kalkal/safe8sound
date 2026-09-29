import { z } from 'zod';
import { EntityIdSchema, IsoDateTimeSchema } from './common.js';
import { CelsiusSchema } from './units.js';

// Counterfactual "without us" (feature queue item 2, approved in #19):
// the same scenario projected with no plan and with the naive plan "AC until the battery dies", next to
// ours, in the safe room. It lets the voice say "without the plan the bedroom would reach 31 °C at 3 am".

export const CounterfactualLineSchema = z.strictObject({
  /** Hottest air temperature of the room over the projection. */
  peakTempC: CelsiusSchema,
  /** When that peak happens. */
  peakAt: IsoDateTimeSchema,
  /**
   * Heat Index degree-hours above 26.7 °C over the projection (EnergyPlus resilience metrics:
   * https://bigladdersoftware.com/epx/docs/24-1/engineering-reference/resilience-metrics.html).
   */
  heatIndexDegreeHours: z.number().nonnegative(),
  /** Night hours (22:00–07:00) at or below the night-recovery threshold. */
  hoursAtOrBelowThreshold: z.number().nonnegative(),
});
export type CounterfactualLine = z.infer<typeof CounterfactualLineSchema>;

export const CounterfactualSchema = z.strictObject({
  roomId: EntityIdSchema,
  scenarios: z.strictObject({
    /** Nothing runs: no cooling, no fans. */
    noPlan: CounterfactualLineSchema,
    /**
     * "AC until the battery dies": the settings running now kept as they are (or, when nothing runs, the
     * comfort setpoint in the safe and occupied rooms), with no pacing and no reserve.
     */
    naive: CounterfactualLineSchema,
    /** The proposed plan. */
    plan: CounterfactualLineSchema,
  }),
});
export type Counterfactual = z.infer<typeof CounterfactualSchema>;
