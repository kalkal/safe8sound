import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';

// Planner settings of the comfort-plan module: config, never constants in code.
// Defaults in apps/mcp-server/config/comfort-plan.json.

const minutes = z.number().int().positive().max(24 * 60);

export const ComfortPlanConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  planTtlMinutes: minutes,
  /** How long the second yes to a last-resort plan may come after the first (#160): at most 10 whole minutes, never past the plan. */
  lastResortConfirmMinutes: z.number().int().positive().max(10),
  /** Occupant roles that switch the night recovery to its elderly threshold (24 °C). */
  elderlyRoles: z.array(z.string().regex(/^[a-z][a-z_-]{0,31}$/)).max(10),
  planner: z.strictObject({
    levelOffsetK: z
      .strictObject({ comfort: z.number().min(0).max(5), balanced: z.number().min(0).max(5), saver: z.number().min(0).max(5) })
      .refine((o) => o.comfort <= o.balanced && o.balanced <= o.saver, { message: 'Offsets grow from comfort to saver' }),
    essentialMarginK: z.number().min(0).max(3),
    dryAboveRhPct: z.number().min(30).max(90),
    targetEveryMinutes: minutes,
    dutyCycles: z
      .array(
        z.strictObject({ onMinutes: minutes, periodMinutes: minutes }).refine((c) => c.onMinutes < c.periodMinutes, {
          message: 'A cycle runs for less than its period',
        }),
      )
      .max(10),
    /** Dry or cool in the safe room by projected humidity: dry above `dryOnPct`, cool again below `dryOffPct`. */
    humidityBand: z
      .strictObject({ dryOnPct: z.number().min(30).max(90), dryOffPct: z.number().min(30).max(90), marginPct: z.number().min(0).max(10) })
      .refine((h) => h.dryOffPct < h.dryOnPct, { message: 'The lower edge of the band is below the upper one' }),
    /** Solar surplus at home instead of on the grid (#203): which export counts, and how far below comfort it cools. */
    surplus: z
      .strictObject({
        $comment: z.string().optional(),
        minExportW: z.number().positive().max(10_000),
        /** Export alone is not a full battery (PV above the maximum charge exports at any SOC): only at or above this. */
        socFullPct: z.number().min(50).max(100),
        offsetK: z.number().min(0).max(3),
        elderlyOffsetK: z.number().min(0).max(3),
      })
      .refine((s) => s.elderlyOffsetK <= s.offsetK, { message: 'The safe room with an elderly person is cooled no further than the others' }),
    /**
     * Household tip from the solar surplus (#219): the loads it may suggest, tried in this order (longest cycle
     * first). Durations and powers are config with their sources in the file, never constants in code.
     */
    householdTip: z.strictObject({
      $comment: z.string().optional(),
      options: z
        .array(
          z
            .strictObject({
              load: z.enum(['washing', 'cooking']),
              cycle: z.enum(['eco', 'normal', 'quick']).optional(),
              durationH: z.number().positive().max(6),
              meanW: z.number().positive().max(5_000),
              peakW: z.number().positive().max(5_000),
            })
            .refine((o) => (o.load === 'washing') === (o.cycle !== undefined), { message: 'A cycle for the washing machine only, and always' })
            .refine((o) => o.meanW <= o.peakW, { message: 'The mean draw is not above the peak' }),
        )
        .max(8),
    }),
  }),
  /** Average load at each level for the reserve outlook; Essential comes from the guard config. */
  outlook: z.strictObject({
    $comment: z.string().optional(),
    levelLoadW: z
      .strictObject({ comfort: z.number().positive(), balanced: z.number().positive(), saver: z.number().positive() })
      .refine((l) => l.comfort >= l.balanced && l.balanced >= l.saver, { message: 'Loads fall from comfort to saver' }),
  }),
});
export type ComfortPlanConfig = z.infer<typeof ComfortPlanConfigSchema>;

export function parseComfortPlanConfig(raw: unknown): Result<ComfortPlanConfig, ErrorEnvelope> {
  const parsed = ComfortPlanConfigSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.').slice(0, 120), message: i.message.slice(0, 200) }));
  return err(toolError('invalid_config', 'The comfort-plan configuration is not valid.', { details: { issues } }));
}
