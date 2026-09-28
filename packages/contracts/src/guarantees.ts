import { z } from 'zod';
import { MeasureUnitSchema } from './units.js';

/** The single list of guarantees (plan §3.1). The guard returns all of them, every time. */
export const GUARANTEE_IDS = ['storm_reserve', 'inverter_limit', 'battery_power', 'safe_room_comfort', 'pacing_on_track'] as const;
export const GuaranteeIdSchema = z.enum(GUARANTEE_IDS);
export type GuaranteeId = z.infer<typeof GuaranteeIdSchema>;

/** The three guarantees shown to the family (screen S1); the receipt shows all five. */
export const FAMILY_GUARANTEES = ['storm_reserve', 'pacing_on_track', 'safe_room_comfort'] as const satisfies readonly GuaranteeId[];

/** One guarantee as checked by the guard. The guard never modifies a plan: it reports and suggests. */
export const GuaranteeResultSchema = z.strictObject({
  id: GuaranteeIdSchema,
  ok: z.boolean(),
  /** Short English sentence: why it holds or why it does not. */
  reason: z.string().min(1).max(300),
  measured: z.number().optional(),
  limit: z.number().optional(),
  nearestAllowed: z.number().optional(),
  unit: MeasureUnitSchema.optional(),
});
export type GuaranteeResult = z.infer<typeof GuaranteeResultSchema>;
