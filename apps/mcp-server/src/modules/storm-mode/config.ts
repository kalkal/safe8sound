import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';

// Storm-mode settings: config, never constants in code. Defaults in config/storm-mode.json.

const positiveInt = (max: number) => z.number().int().positive().max(max);

export const StormModeConfigSchema = z.strictObject({
  $comment: z.string().optional(),
  schemaVersion: z.literal(1),
  capHours: z.number().positive().max(72),
  stableGridMinutes: positiveInt(120),
  minIntervalMinutes: positiveInt(24 * 60),
  epsBaseLoadW: z.number().positive().max(5000),
  occupantGainW: z.number().nonnegative().max(300),
  inApp: z.strictObject({ maxPerHome: positiveInt(500), ttlHours: positiveInt(24 * 7) }),
});
export type StormModeConfig = z.infer<typeof StormModeConfigSchema>;

export function parseStormModeConfig(raw: unknown): Result<StormModeConfig, ErrorEnvelope> {
  const parsed = StormModeConfigSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.').slice(0, 120), message: i.message.slice(0, 200) }));
  return err(toolError('invalid_config', 'The storm-mode configuration is not valid.', { details: { issues } }));
}
