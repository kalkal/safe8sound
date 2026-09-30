import { z } from 'zod';
import { EntityIdSchema, HomeIdSchema, IsoDateTimeSchema, RoleSchema, epochMs } from './common.js';
import { HomeLinkSchema } from './snapshot.js';
import { DataOriginSchema } from './origin.js';
import { LevelReasonSchema, LevelSchema } from './pacing.js';
import { ContactChannelSchema } from './preferences.js';
import { CelsiusSchema, PctSchema } from './units.js';

// Storm mode contracts (plan §3.1, §9.2, §11.2 p.8, §13.2.4). Additive, approved in #23.

export const STORM_SCHEMA_VERSION = 1;

export const StormIdSchema = z
  .string()
  .regex(/^storm_[A-Za-z0-9]{8,40}$/)
  .brand<'StormId'>();
export type StormId = z.infer<typeof StormIdSchema>;

export const StormPhaseSchema = z.enum(['prepare', 'active', 'ended']);
export type StormPhase = z.infer<typeof StormPhaseSchema>;

export const StormTriggerSchema = z.enum(['grid_loss', 'user', 'forecast', 'scenario']);
export type StormTrigger = z.infer<typeof StormTriggerSchema>;

export const StormTransitionSchema = z.enum(['storm_prepared', 'storm_started', 'essential_level', 'power_back']);
export type StormTransition = z.infer<typeof StormTransitionSchema>;

/** The transitions a family message is sent for; `storm_prepared` is only spoken (plan §11.2 p.8). */
export const SENDABLE_TRANSITIONS = ['storm_started', 'essential_level', 'power_back'] as const satisfies readonly StormTransition[];
export const SendableTransitionSchema = z.enum(SENDABLE_TRANSITIONS);
export type SendableTransition = z.infer<typeof SendableTransitionSchema>;

/** One message sent to a family contact, by role and channel: names and handles are never stored here. */
export const StormNotificationSchema = z.strictObject({
  at: IsoDateTimeSchema,
  transition: SendableTransitionSchema,
  contactRole: RoleSchema,
  channel: ContactChannelSchema,
  delivered: z.boolean(),
});
export type StormNotification = z.infer<typeof StormNotificationSchema>;

export const StormSessionSchema = z
  .strictObject({
    schemaVersion: z.literal(STORM_SCHEMA_VERSION),
    id: StormIdSchema,
    homeId: HomeIdSchema,
    phase: StormPhaseSchema,
    trigger: StormTriggerSchema,
    startedAt: IsoDateTimeSchema,
    /** When the grid was lost and the reserve became the budget. */
    activeAt: IsoDateTimeSchema.optional(),
    /** First reading with the grid back: starts the stable-grid window before `ended` (plan §9.2). */
    gridBackAt: IsoDateTimeSchema.optional(),
    endedAt: IsoDateTimeSchema.optional(),
    safeRoomId: EntityIdSchema,
    occupantRoles: z.array(RoleSchema).max(20),
    /** Safe hours at the essential level when the session started. */
    hoursAtEssential: z.number().nonnegative(),
    scenario: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,47}$/)
      .optional(),
    notifications: z.array(StormNotificationSchema).max(50),
  })
  .superRefine((s, ctx) => {
    if ((s.phase === 'ended') !== (s.endedAt !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['endedAt'], message: 'endedAt is present exactly when the phase is ended' });
    }
    if (s.phase === 'active' && s.activeAt === undefined) {
      ctx.addIssue({ code: 'custom', path: ['activeAt'], message: 'An active storm says when it became active' });
    }
    const times = [s.startedAt, s.activeAt, s.gridBackAt, s.endedAt].filter((t): t is string => t !== undefined).map(epochMs);
    if (times.some((t, i) => i > 0 && t < (times[i - 1] ?? t))) {
      ctx.addIssue({ code: 'custom', path: ['startedAt'], message: 'startedAt <= activeAt <= gridBackAt <= endedAt' });
    }
  });
export type StormSession = z.infer<typeof StormSessionSchema>;

// Tool I/O.

export const StartStormModeInputSchema = z.strictObject({ mode: z.enum(['prepare', 'active']) });

export const StartStormModeOutputSchema = z.strictObject({
  session: StormSessionSchema,
  /** `active` only with the grid measured down; otherwise `prepare`. */
  effectiveMode: z.enum(['prepare', 'active']),
  reserveUnlocked: z.boolean(),
  reason: z.enum(['requested', 'grid_still_up', 'grid_lost']),
  safeHours: z.number().nonnegative(),
  safeUntil: IsoDateTimeSchema,
});

export const SafeRoomStatusSchema = z.strictObject({
  safeRoomId: EntityIdSchema,
  tempC: CelsiusSchema,
  humidityPct: PctSchema.optional(),
  occupantRoles: z.array(RoleSchema).max(20),
  level: LevelSchema,
  levelReason: LevelReasonSchema,
  safeHours: z.number().nonnegative(),
  safeUntil: IsoDateTimeSchema,
  stormPhase: StormPhaseSchema.optional(),
  origin: DataOriginSchema,
  homeLink: HomeLinkSchema,
});
export type SafeRoomStatus = z.infer<typeof SafeRoomStatusSchema>;

/** No free text, recipient, handle or phone: the server fills a template from its own state. */
export const NotifyFamilyInputSchema = z.strictObject({
  transition: SendableTransitionSchema,
  /** Registered contact roles; all registered contacts when absent. */
  roles: z.array(RoleSchema).min(1).max(3).optional(),
});

export const NotifyFamilyOutputSchema = z.strictObject({
  sent: z.array(z.strictObject({ role: RoleSchema, channel: ContactChannelSchema })).max(3),
  skipped: z.array(z.strictObject({ role: RoleSchema, reason: z.enum(['not_registered', 'rate_limited']) })).max(3),
  /** The message as the model may see it: roles, never names. */
  preview: z.string().min(1).max(600),
});
