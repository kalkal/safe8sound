import { z } from 'zod';
import { EntityIdSchema, RoleSchema } from './common.js';
import {
  ConfigChangeSchema,
  ContactChannelSchema,
  LanguageSchema,
  SafetyHardLimitsSchema,
  SafetyThresholdsSchema,
  type Preferences,
} from './preferences.js';
import { CelsiusSchema, PctSchema } from './units.js';

// The preferences as the tools and the cards see them (approved in #21). Contacts carry names,
// so they appear by role and channel only: names and handles never reach the model or a card
// (plan §3.1, #1·19a). Moved from apps/mcp-server so the simulator and the cards share them.

export const PublicPreferencesSchema = z.strictObject({
  comfortC: z.strictObject({ cooling: CelsiusSchema, heating: CelsiusSchema }),
  safeRoomId: EntityIdSchema,
  roomPriority: z.array(EntityIdSchema),
  safety: SafetyThresholdsSchema,
  autoStormOnGridLoss: z.boolean(),
  /** Roles and channels only: names and handles stay out of the model. */
  contacts: z.array(z.strictObject({ role: RoleSchema, channel: ContactChannelSchema })).max(3),
  language: LanguageSchema,
});
export type PublicPreferences = z.infer<typeof PublicPreferencesSchema>;

export const toPublicPreferences = (p: Preferences): PublicPreferences => ({
  comfortC: p.comfortC,
  safeRoomId: p.safeRoomId,
  roomPriority: p.roomPriority,
  safety: p.safety,
  autoStormOnGridLoss: p.autoStormOnGridLoss,
  contacts: p.familyContacts.map(({ role, channel }) => ({ role, channel })),
  language: p.language,
});

/** Output of `get_preferences`. */
export const GetPreferencesOutputSchema = z.strictObject({
  preferences: PublicPreferencesSchema,
  isDefault: z.boolean(),
  hardLimits: SafetyHardLimitsSchema,
  /** #422 (additive): the rooms by their display name from the home profile, so a card or the settings never show an id. */
  rooms: z.array(z.strictObject({ id: EntityIdSchema, name: z.string().min(1).max(40) })).max(20).optional(),
});
export type GetPreferencesOutput = z.infer<typeof GetPreferencesOutputSchema>;

/** Input of `set_preferences`: a partial change, sent only after the person confirmed it. */
export const SetPreferencesInputSchema = z.strictObject({
  comfortC: z.strictObject({ cooling: z.number().optional(), heating: z.number().optional() }).optional(),
  safeRoomId: z.string().max(64).optional(),
  roomPriority: z.array(z.string().max(64)).max(20).optional(),
  safety: z
    .strictObject({
      cooling: z.strictObject({ maxC: z.number().optional() }).optional(),
      heating: z.strictObject({ minC: z.number().optional() }).optional(),
      humidity: z.strictObject({ minPct: PctSchema.optional(), maxPct: PctSchema.optional() }).optional(),
      stricterNightLimit: z.boolean().optional(),
      heatIndexCapC: z.number().optional(),
      elderlyCapC: z.number().optional(),
    })
    .optional(),
  autoStormOnGridLoss: z.boolean().optional(),
  language: LanguageSchema.optional(),
  confirmed: z.literal(true).describe('true only after the person confirmed this exact change, by voice or touch.'),
});
export type SetPreferencesInput = z.infer<typeof SetPreferencesInputSchema>;

/** Output of `set_preferences`: the new public view and the logged changes. */
export const SetPreferencesOutputSchema = z.strictObject({
  preferences: PublicPreferencesSchema,
  changes: z.array(ConfigChangeSchema),
});
export type SetPreferencesOutput = z.infer<typeof SetPreferencesOutputSchema>;
