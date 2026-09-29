import {
  CelsiusSchema,
  ConfigChangeSchema,
  ContactChannelSchema,
  EntityIdSchema,
  LanguageSchema,
  PctSchema,
  RoleSchema,
  SafetyHardLimitsSchema,
  SafetyThresholdsSchema,
  ok,
  type HomeId,
  type Preferences,
  type SafetyHardLimits,
} from '@cold-reserve/contracts';
import { updatePreferences, type Clock, type StateStoreFactory } from '@cold-reserve/core';
import { z } from 'zod';
import type { CapabilityModule } from '../registry.js';
import { defineTool } from '../tool.js';

// `preferences` capability module (plan §14.1, issue #20): read and change the comfort setpoints,
// the safety thresholds (inside the hard limits from config), the safe room, the room priority and
// the language. Contacts carry names, so they are never read from or written by the model:
// the tools show roles only, and contacts are edited in the app (plan §3.1, #1·19a).

export interface PreferencesModuleDeps {
  readonly storeFor: StateStoreFactory;
  /** Hard limits and defaults per season, from config. */
  readonly limits: SafetyHardLimits;
  /** Room ids of the home profile. */
  readonly roomIdsFor: (homeId: HomeId) => readonly string[];
  /** What a home uses before anyone saved preferences (from config). */
  readonly defaultsFor: (homeId: HomeId) => Preferences;
  readonly clock: Clock;
}

const PublicPreferencesSchema = z.strictObject({
  comfortC: z.strictObject({ cooling: CelsiusSchema, heating: CelsiusSchema }),
  safeRoomId: EntityIdSchema,
  roomPriority: z.array(EntityIdSchema),
  safety: SafetyThresholdsSchema,
  autoStormOnGridLoss: z.boolean(),
  /** Roles and channels only: names and handles stay out of the model. */
  contacts: z.array(z.strictObject({ role: RoleSchema, channel: ContactChannelSchema })).max(3),
  language: LanguageSchema,
});

const toPublic = (p: Preferences): z.input<typeof PublicPreferencesSchema> => ({
  comfortC: p.comfortC,
  safeRoomId: p.safeRoomId,
  roomPriority: p.roomPriority,
  safety: p.safety,
  autoStormOnGridLoss: p.autoStormOnGridLoss,
  contacts: p.familyContacts.map(({ role, channel }) => ({ role, channel })),
  language: p.language,
});

// set_preferences overwrites safety thresholds: marked destructive, so the host asks for confirmation.
// That host prompt is the one gate a prompt injection cannot bypass.
const annotations = (readOnly: boolean) => ({ readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: false });

export function preferencesModule(deps: PreferencesModuleDeps): CapabilityModule {
  const current = async (homeId: HomeId) => {
    const saved = await deps.storeFor(homeId).getPreferences();
    if (!saved.ok) return saved;
    return ok(saved.value === undefined ? { preferences: deps.defaultsFor(homeId), isDefault: true } : { preferences: saved.value, isDefault: false });
  };

  const getPreferences = defineTool({
    name: 'get_preferences',
    title: 'Get preferences',
    description:
      "The home's comfort setpoints per season, safety thresholds of the safe room with their hard limits, safe room, room priority and language. Contacts are listed by role only.",
    annotations: annotations(true),
    input: z.strictObject({}),
    output: z.strictObject({ preferences: PublicPreferencesSchema, isDefault: z.boolean(), hardLimits: SafetyHardLimitsSchema }),
    summarize: (o) =>
      `${o.isDefault ? 'Default' : 'Saved'} preferences: cool to ${String(o.preferences.comfortC.cooling)} C, safe room ${o.preferences.safeRoomId}.`,
    handler: async (_args, ctx) => {
      const read = await current(ctx.homeId);
      if (!read.ok) return read;
      return ok({ preferences: toPublic(read.value.preferences), isDefault: read.value.isDefault, hardLimits: deps.limits });
    },
  });

  const setPreferences = defineTool({
    name: 'set_preferences',
    title: 'Change preferences',
    description:
      'Changes comfort setpoints, safety thresholds (only inside the hard limits), the safe room, the room priority (safe room first) or the language. Call it only after the person confirmed the exact change; every change is logged.',
    annotations: annotations(false),
    input: z.strictObject({
      comfortC: z.strictObject({ cooling: z.number().optional(), heating: z.number().optional() }).optional(),
      safeRoomId: z.string().max(64).optional(),
      roomPriority: z.array(z.string().max(64)).max(20).optional(),
      safety: z
        .strictObject({
          cooling: z.strictObject({ maxC: z.number().optional() }).optional(),
          heating: z.strictObject({ minC: z.number().optional() }).optional(),
          humidity: z.strictObject({ minPct: PctSchema.optional(), maxPct: PctSchema.optional() }).optional(),
        })
        .optional(),
      autoStormOnGridLoss: z.boolean().optional(),
      language: LanguageSchema.optional(),
      confirmed: z.literal(true).describe('true only after the person confirmed this exact change, by voice or touch.'),
    }),
    output: z.strictObject({ preferences: PublicPreferencesSchema, changes: z.array(ConfigChangeSchema) }),
    summarize: (o) => (o.changes.length === 0 ? 'Nothing changed.' : `Saved: ${o.changes.map((c) => c.field).join(', ')}.`),
    handler: async (args, ctx) => {
      const read = await current(ctx.homeId);
      if (!read.ok) return read;
      // `confirmed` is checked by the input schema (literal true); the rest is the update.
      const update = { ...args, confirmed: undefined };
      const next = updatePreferences(read.value.preferences, update, {
        limits: deps.limits,
        roomIds: deps.roomIdsFor(ctx.homeId),
        at: new Date(deps.clock.now()).toISOString(),
        by: 'user',
        // The model passed confirmed: true after the host prompt; the log says so, not more.
        confirmedVia: 'tool',
      });
      if (!next.ok) return next;
      const saved = await deps.storeFor(ctx.homeId).putPreferences(next.value.preferences, next.value.changes);
      if (!saved.ok) return saved;
      return ok({ preferences: toPublic(next.value.preferences), changes: next.value.changes });
    },
  });

  return { id: 'preferences', tools: [getPreferences, setPreferences] };
}
