import { err, ok, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';
import { invalidConfig, zodIssues } from './config-error.js';

// Simulator physics parameters: config, never constants in code. Defaults in
// data/simulator-params.json come from spike S6; values marked as assumptions there must be
// calibrated on real data.

const nonNegative = z.number().nonnegative();
const fraction = z.number().min(0).max(1);

export const SimulatorParamsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  hvac: z.strictObject({ dryInputFactor: fraction, drySensibleFactor: fraction, fanOnlyInputW: nonNegative }),
  gains: z.strictObject({ perRoomBaseW: nonNegative, perOccupantW: nonNegative }),
  solarApertureM2: z.strictObject({ default: nonNegative, byRoom: z.record(z.string(), nonNegative) }),
  humidity: z.strictObject({ exchangeTimeConstantH: z.number().positive(), coolRemovalPctPerH: nonNegative, dryRemovalPctPerH: nonNegative }),
  pv: z.strictObject({ lossRatio: fraction }),
  load: z.strictObject({ noiseRatio: fraction }),
  /** Feels-like effect of a running fan, used by the comfort levels only. */
  comfort: z.strictObject({ fanEffectC: nonNegative }),
});
export type SimulatorParams = z.infer<typeof SimulatorParamsSchema>;

export function parseSimParams(raw: unknown): Result<SimulatorParams, ErrorEnvelope> {
  const parsed = SimulatorParamsSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(invalidConfig('Simulator parameters', zodIssues(parsed.error)));
}
