import { z } from 'zod';
import { EntityIdSchema, IsoDateTimeSchema, RoleSchema } from './common.js';
import { toolError, type ErrorEnvelope } from './errors.js';
import { err, ok, type Result } from './result.js';
import { CelsiusSchema, PctSchema, type MeasureUnit } from './units.js';

export const PREFERENCES_SCHEMA_VERSION = 1;

/** Safety thresholds of the safe room, measured on air temperature and relative humidity (plan §3.1). */
export const SafetyThresholdsSchema = z.strictObject({
  cooling: z.strictObject({ maxC: CelsiusSchema }),
  heating: z.strictObject({ minC: CelsiusSchema }),
  humidity: z
    .strictObject({ minPct: PctSchema, maxPct: PctSchema })
    .refine((h) => h.minPct < h.maxPct, { message: 'Expected minPct < maxPct' }),
});
export type SafetyThresholds = z.infer<typeof SafetyThresholdsSchema>;

const ordered = (b: { min: number; max: number; default: number }) => b.min <= b.default && b.default <= b.max;
const orderedMessage = { message: 'Expected min <= default <= max' };
const CelsiusBoundSchema = z.strictObject({ min: CelsiusSchema, max: CelsiusSchema, default: CelsiusSchema }).refine(ordered, orderedMessage);
const PctBoundSchema = z.strictObject({ min: PctSchema, max: PctSchema, default: PctSchema }).refine(ordered, orderedMessage);

/** Hard limits and defaults per season. They come from config; people move thresholds only inside them. */
export const SafetyHardLimitsSchema = z.strictObject({
  cooling: z.strictObject({ maxC: CelsiusBoundSchema }),
  heating: z.strictObject({ minC: CelsiusBoundSchema }),
  humidity: z.strictObject({ minPct: PctBoundSchema, maxPct: PctBoundSchema }),
});
export type SafetyHardLimits = z.infer<typeof SafetyHardLimitsSchema>;

/** Notification channels. Only the simulated in-app phone for the hackathon (plan §11.2 p.8). */
export const ContactChannelSchema = z.enum(['in_app']);

export const FamilyContactSchema = z.strictObject({
  role: RoleSchema,
  /** Used only by the notification template, never passed to the model. */
  name: z.string().min(1).max(40),
  channel: ContactChannelSchema,
  handle: z.string().min(1).max(80),
});
export type FamilyContact = z.infer<typeof FamilyContactSchema>;

export const LanguageSchema = z.enum(['en-US', 'it-IT']);

export const PreferencesSchema = z
  .strictObject({
    schemaVersion: z.literal(PREFERENCES_SCHEMA_VERSION),
    comfortC: z.strictObject({ cooling: CelsiusSchema, heating: CelsiusSchema }),
    safeRoomId: EntityIdSchema,
    /** Room order for the inverter limit and the pacing; the safe room is always first. */
    roomPriority: z.array(EntityIdSchema).min(1),
    safety: SafetyThresholdsSchema,
    autoStormOnGridLoss: z.boolean(),
    familyContacts: z.array(FamilyContactSchema).max(3),
    language: LanguageSchema,
  })
  .superRefine((p, ctx) => {
    if (p.roomPriority[0] !== p.safeRoomId) {
      ctx.addIssue({ code: 'custom', path: ['roomPriority'], message: 'The safe room comes first' });
    }
    if (new Set(p.roomPriority).size !== p.roomPriority.length) {
      ctx.addIssue({ code: 'custom', path: ['roomPriority'], message: 'Rooms must be unique' });
    }
    if (p.comfortC.cooling > p.safety.cooling.maxC) {
      ctx.addIssue({ code: 'custom', path: ['comfortC', 'cooling'], message: 'Comfort is above the cooling safety maximum' });
    }
    if (p.comfortC.heating < p.safety.heating.minC) {
      ctx.addIssue({ code: 'custom', path: ['comfortC', 'heating'], message: 'Comfort is below the heating safety minimum' });
    }
  });
export type Preferences = z.infer<typeof PreferencesSchema>;

/** Checks the chosen thresholds against the hard limits; reports the nearest allowed value. */
export function checkSafetyWithinLimits(safety: SafetyThresholds, limits: SafetyHardLimits): Result<SafetyThresholds, ErrorEnvelope> {
  const checks: Array<{ field: string; value: number; min: number; max: number; unit: MeasureUnit }> = [
    { field: 'safety.cooling.maxC', value: safety.cooling.maxC, ...limits.cooling.maxC, unit: 'C' },
    { field: 'safety.heating.minC', value: safety.heating.minC, ...limits.heating.minC, unit: 'C' },
    { field: 'safety.humidity.minPct', value: safety.humidity.minPct, ...limits.humidity.minPct, unit: '%' },
    { field: 'safety.humidity.maxPct', value: safety.humidity.maxPct, ...limits.humidity.maxPct, unit: '%' },
  ];
  for (const c of checks) {
    if (c.value < c.min || c.value > c.max) {
      const limit = c.value < c.min ? c.min : c.max;
      return err(
        toolError('safety_threshold_out_of_range', `${c.field} must stay between ${String(c.min)} and ${String(c.max)} ${c.unit}.`, {
          details: { field: c.field, measured: c.value, limit, nearestAllowed: limit, unit: c.unit },
        }),
      );
    }
  }
  return ok(safety);
}

/** Every confirmed change of the configuration is recorded (plan §3.1, EVENT# items). */
export const ConfigChangeSchema = z.strictObject({
  ts: IsoDateTimeSchema,
  field: z.string().min(1).max(120),
  from: z.union([z.number(), z.string(), z.boolean()]),
  to: z.union([z.number(), z.string(), z.boolean()]),
  by: z.enum(['user', 'scenario']),
  confirmed: z.literal(true),
});
export type ConfigChange = z.infer<typeof ConfigChangeSchema>;
