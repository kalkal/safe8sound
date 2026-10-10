import { z } from 'zod';
import { EntityIdSchema, IsoDateTimeSchema, RoleSchema } from './common.js';
import { toolError, type ErrorEnvelope } from './errors.js';
import { err, ok, type Result } from './result.js';
import { CelsiusSchema, PctSchema, formatTempForInput, type MeasureUnit, type TempUnit } from './units.js';

/** A bound of a range in a refusal: in a °F sandbox a °C bound is said in °F with the °C to send (#306 review). */
const bound = (value: number, measure: MeasureUnit, unit: TempUnit): string => (measure === 'C' && unit === 'F' ? formatTempForInput(value, 'F') : String(value));

export const PREFERENCES_SCHEMA_VERSION = 1;

/** The heat-index cap for everyone: where the NWS "Extreme Caution" band starts (https://www.weather.gov/ama/heatindex). */
export const HEAT_INDEX_CAP_MAX_C = 32.2;
/** The air cap with an older person: above it, health effects escalate (Health Canada, upper indoor limits for older adults). */
export const ELDERLY_CAP_MAX_C = 31;

/** Safety thresholds of the safe room, measured on air temperature and relative humidity (plan §3.1). */
export const SafetyThresholdsSchema = z.strictObject({
  cooling: z.strictObject({ maxC: CelsiusSchema }),
  heating: z.strictObject({ minC: CelsiusSchema }),
  /**
   * `maxPct` is the humid-air warning threshold and the planner's dry band, never a refusal (#248): humid air alone
   * is not a heat danger. `minPct` refuses only where the plan dries the room (#107).
   */
  humidity: z
    .strictObject({ minPct: PctSchema, maxPct: PctSchema })
    .refine((h) => h.minPct < h.maxPct, { message: 'Expected minPct < maxPct' }),
  /** The night limit (26 °C, 24 °C with an older person) for every plan, not only the last resort (#266). Default off. */
  stricterNightLimit: z.boolean().optional(),
  /** The heat-index cap, only stricter than HEAT_INDEX_CAP_MAX_C (#266). */
  heatIndexCapC: CelsiusSchema.optional(),
  /** The air cap with an older person, only stricter than ELDERLY_CAP_MAX_C (#266). */
  elderlyCapC: CelsiusSchema.optional(),
});
export type SafetyThresholds = z.infer<typeof SafetyThresholdsSchema>;

const ordered = (b: { min: number; max: number; default: number }) => b.min <= b.default && b.default <= b.max;
const orderedMessage = { message: 'Expected min <= default <= max' };
const CelsiusBoundSchema = z.strictObject({ min: CelsiusSchema, max: CelsiusSchema, default: CelsiusSchema }).refine(ordered, orderedMessage);
const PctBoundSchema = z.strictObject({ min: PctSchema, max: PctSchema, default: PctSchema }).refine(ordered, orderedMessage);

/** Hard limits and defaults per season. They come from config; people move thresholds only inside them. */
const capBound = (constant: number) => CelsiusBoundSchema.refine((b) => b.max <= constant, { message: `Expected max <= ${String(constant)}: a cap may only be stricter` });

export const SafetyHardLimitsSchema = z.strictObject({
  cooling: z.strictObject({ maxC: CelsiusBoundSchema }),
  heating: z.strictObject({ minC: CelsiusBoundSchema }),
  humidity: z.strictObject({ minPct: PctBoundSchema, maxPct: PctBoundSchema }),
  stricterNightLimit: z.strictObject({ default: z.boolean() }).optional(),
  heatIndexCapC: capBound(HEAT_INDEX_CAP_MAX_C).optional(),
  elderlyCapC: capBound(ELDERLY_CAP_MAX_C).optional(),
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

/** A cap's range: the configured bounds, or up to the health constant when none are configured. */
const capRange = (bound: { min: number; max: number } | undefined, constant: number) => ({ min: bound?.min ?? 0, max: Math.min(bound?.max ?? constant, constant) });

/**
 * The heat-safety settings the guard plays (#266): the defaults when unset, and a cap never looser than its health
 * constant, whatever was stored (the clamp on read; the bounds refuse it on write).
 */
export function effectiveHeatSafety(safety: SafetyThresholds): { stricterNightLimit: boolean; heatIndexCapC: number; elderlyCapC: number } {
  return {
    stricterNightLimit: safety.stricterNightLimit ?? false,
    heatIndexCapC: Math.min(safety.heatIndexCapC ?? HEAT_INDEX_CAP_MAX_C, HEAT_INDEX_CAP_MAX_C),
    elderlyCapC: Math.min(safety.elderlyCapC ?? ELDERLY_CAP_MAX_C, ELDERLY_CAP_MAX_C),
  };
}

/** Checks the chosen thresholds against the hard limits; reports the nearest allowed value. */
export function checkSafetyWithinLimits(safety: SafetyThresholds, limits: SafetyHardLimits, unit: TempUnit = 'C'): Result<SafetyThresholds, ErrorEnvelope> {
  const checks: Array<{ field: string; value: number; min: number; max: number; unit: MeasureUnit }> = [
    { field: 'safety.cooling.maxC', value: safety.cooling.maxC, ...limits.cooling.maxC, unit: 'C' },
    { field: 'safety.heating.minC', value: safety.heating.minC, ...limits.heating.minC, unit: 'C' },
    { field: 'safety.humidity.minPct', value: safety.humidity.minPct, ...limits.humidity.minPct, unit: '%' },
    { field: 'safety.humidity.maxPct', value: safety.humidity.maxPct, ...limits.humidity.maxPct, unit: '%' },
    ...(safety.heatIndexCapC === undefined ? [] : [{ field: 'safety.heatIndexCapC', value: safety.heatIndexCapC, ...capRange(limits.heatIndexCapC, HEAT_INDEX_CAP_MAX_C), unit: 'C' as const }]),
    ...(safety.elderlyCapC === undefined ? [] : [{ field: 'safety.elderlyCapC', value: safety.elderlyCapC, ...capRange(limits.elderlyCapC, ELDERLY_CAP_MAX_C), unit: 'C' as const }]),
  ];
  for (const c of checks) {
    if (c.value < c.min || c.value > c.max) {
      const limit = c.value < c.min ? c.min : c.max;
      return err(
        toolError('safety_threshold_out_of_range', `${c.field} must stay between ${bound(c.min, c.unit, unit)} and ${bound(c.max, c.unit, unit)}${c.unit === 'C' && unit === 'F' ? '' : ` ${c.unit}`}.`, {
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
  /** Where the confirmation came from: the MCP tool (after the host prompt) or the app. Additive, approved in #20. */
  confirmedVia: z.enum(['tool', 'app']).optional(),
});
export type ConfigChange = z.infer<typeof ConfigChangeSchema>;
