import {
  CelsiusSchema,
  LanguageSchema,
  PreferencesSchema,
  SafetyHardLimitsSchema,
  err,
  ok,
  toolError,
  type ErrorEnvelope,
  type HomeProfile,
  type Preferences,
  type Result,
} from '@cold-reserve/contracts';
import { z } from 'zod';
import file from '../config/preferences.json' with { type: 'json' };

// Hard limits and defaults of the preferences (plan §3.1): data in config/preferences.json,
// validated once at startup; an invalid file stops the server with invalid_config.

export const PreferencesConfigSchema = z.strictObject({
  $comment: z.string().optional(),
  limits: SafetyHardLimitsSchema,
  comfortC: z.strictObject({ cooling: CelsiusSchema, heating: CelsiusSchema }),
  autoStormOnGridLoss: z.boolean(),
  language: LanguageSchema,
});
export type PreferencesConfig = z.infer<typeof PreferencesConfigSchema>;

/** The shipped file, as stored (validate it with loadPreferencesConfig). */
export const preferencesConfigFile = (): unknown => structuredClone(file);

const issuesOf = (error: z.ZodError) => error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join('.'), message: i.message.slice(0, 200) }));

export function loadPreferencesConfig(raw: unknown): Result<PreferencesConfig, ErrorEnvelope> {
  const parsed = PreferencesConfigSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  return err(toolError('invalid_config', 'config/preferences.json is not valid.', { details: { issues: issuesOf(parsed.error) } }));
}

/** What a home uses before anyone saved preferences: config defaults, safe room first, no contacts. */
export function defaultPreferencesFor(config: PreferencesConfig, profile: HomeProfile): Result<Preferences, ErrorEnvelope> {
  const safeRoom = profile.rooms.find((room) => room.isSafeRoom);
  if (!safeRoom) return err(toolError('invalid_config', `Home profile ${profile.homeId} has no safe room.`));
  const parsed = PreferencesSchema.safeParse({
    schemaVersion: 1,
    comfortC: config.comfortC,
    safeRoomId: safeRoom.id,
    roomPriority: [safeRoom.id, ...profile.rooms.filter((room) => room.id !== safeRoom.id).map((room) => room.id)],
    safety: {
      cooling: { maxC: config.limits.cooling.maxC.default },
      heating: { minC: config.limits.heating.minC.default },
      humidity: { minPct: config.limits.humidity.minPct.default, maxPct: config.limits.humidity.maxPct.default },
    },
    autoStormOnGridLoss: config.autoStormOnGridLoss,
    familyContacts: [],
    language: config.language,
  });
  if (parsed.success) return ok(parsed.data);
  return err(toolError('invalid_config', 'The default preferences do not fit their own safety thresholds.', { details: { issues: issuesOf(parsed.error) } }));
}
