import { z } from 'zod';
import { EntityIdSchema, HomeIdSchema, IsoDateTimeSchema, RoleSchema, epochMs } from './common.js';
import { HomeLinkSchema } from './snapshot.js';
import { DataOriginSchema } from './origin.js';
import { LevelReasonSchema, LevelSchema } from './pacing.js';
import { ContactChannelSchema } from './preferences.js';
import { DeviceAdviceSchema, DeviceSecuredSchema, FamilyReplySchema } from './storm-prep.js';
import { CelsiusSchema, PctSchema } from './units.js';
import { PlanIdSchema } from './plan.js';

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

export const StormTransitionSchema = z.enum(['storm_prepared', 'storm_started', 'essential_level', 'power_back', 'last_resort_applied']);
export type StormTransition = z.infer<typeof StormTransitionSchema>;

/**
 * The transitions a family message is sent for. `last_resort_applied` is sent by the server when a last-resort plan is
 * applied (approved in #160). `storm_prepared` is sent once per storm when it is prepared for a forecast storm (owner
 * decision, #390; it was only spoken before, plan §11.2 p.8). Added last: the order of the others is unchanged.
 */
export const SENDABLE_TRANSITIONS = ['storm_started', 'essential_level', 'power_back', 'last_resort_applied', 'storm_prepared'] as const satisfies readonly StormTransition[];
export const SendableTransitionSchema = z.enum(SENDABLE_TRANSITIONS);
export type SendableTransition = z.infer<typeof SendableTransitionSchema>;

/** The transitions notify_family accepts from the model: the last-resort alert is never the model's call (#160). */
export const MODEL_NOTIFIABLE_TRANSITIONS = ['storm_started', 'essential_level', 'power_back'] as const satisfies readonly SendableTransition[];

/**
 * A rendered family message. Only `stormMessage` in @cold-reserve/i18n produces it (from a template and
 * fields); a cast anywhere else is a lint error, so no free text ever reaches a family contact.
 */
export type StormMessageText = string & z.$brand<'StormMessageText'>;

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
    /** Devices made safe on entering the storm, demo homes only (queue item 7, approved in #24). */
    devicesSecured: z.array(DeviceSecuredSchema).max(10).optional(),
    /** The family's replies from the phone, by role (queue item 3, approved in #24). */
    familyReplies: z.array(FamilyReplySchema).max(50).optional(),
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

export const StartStormModeInputSchema = z.strictObject({
  mode: z.enum(['prepare', 'active']),
  /**
   * The person said yes to "the forecast shows no storm, shall I get the home ready anyway?" (optional, additive, 21 Oct):
   * only then does a request start a preparation when the grid is up, no storm is open and none is forecast.
   */
  confirmed: z
    .boolean()
    .optional()
    .describe('true only after the person said yes to "shall I get the home ready anyway?" when the forecast shows no storm and the grid is on'),
});

/** What start_storm_mode says when it starts nothing (grid on, no storm open or forecast, no confirmation): the start the answer rules look for. */
export const STORM_NOT_FORECAST_START = 'The forecast shows no storm and the grid is on.';
/** The question the model asks the person: the tool's own words, said as they are. */
export const STORM_NOT_FORECAST_ASK = 'The forecast I read shows no storm tonight. Shall I get the home ready anyway?';

/**
 * The tool's sentence for that refusal, one place for the server, the fake world of the evals and the answer rules.
 * `endedAStorm`: the same call first ended a storm (power back, the family told), which the text then says.
 */
export function stormNotForecastMessage(endedAStorm = false): string {
  return (
    `${STORM_NOT_FORECAST_START} No storm was started and no one was told about one.` +
    (endedAStorm ? ' Power is back; the family was told.' : '') +
    ` Ask the person: "${STORM_NOT_FORECAST_ASK}" Only after their yes, call it again with confirmed true.`
  );
}

export const StartStormModeOutputSchema = z
  .strictObject({
    session: StormSessionSchema,
    /** `active` only with the grid measured down; otherwise `prepare`. */
    effectiveMode: z.enum(['prepare', 'active']),
    reserveUnlocked: z.boolean(),
    reason: z.enum(['requested', 'grid_still_up', 'grid_lost']),
    safeHours: z.number().nonnegative(),
    safeUntil: IsoDateTimeSchema,
    /** The read-only home only: what to make safe by hand (approved in #24, Q6). */
    deviceAdvice: z.array(DeviceAdviceSchema).max(10).optional(),
  })
  .superRefine((o, ctx) => {
    if (o.reserveUnlocked !== (o.effectiveMode === 'active')) {
      ctx.addIssue({ code: 'custom', path: ['reserveUnlocked'], message: 'The reserve is unlocked exactly when the storm is active' });
    }
    if (o.session.phase !== o.effectiveMode) {
      ctx.addIssue({ code: 'custom', path: ['session', 'phase'], message: 'The session phase is the effective mode' });
    }
    if ((o.reason === 'grid_lost') !== (o.effectiveMode === 'active')) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'grid_lost goes with active; requested and grid_still_up with prepare' });
    }
  });

/** What sets the safe room's temperature limit at an instant (the guard's safeRoomLimitKindAt). */
export const SafeRoomLimitKindSchema = z.enum(['maximum', 'night', 'older_person_cap', 'heat_index_cap', 'minimum']);
export type SafeRoomLimitKindName = z.infer<typeof SafeRoomLimitKindSchema>;

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
  /** Whether the grid is up now (#273, approved in #273): then the safe hours are only what the battery alone would hold. */
  gridAvailable: z.boolean().optional(),
  /** The family's latest reply in this storm, by role only (approved in #24). */
  lastCheckIn: FamilyReplySchema.optional(),
  /** The plan applied last while it runs (additive, owner 21 Oct): the rest tile says "Plan active"; its time on the home's clock. */
  activePlan: z.strictObject({ planId: PlanIdSchema, until: IsoDateTimeSchema }).optional(),
  origin: DataOriginSchema,
  homeLink: HomeLinkSchema,
  /**
   * #114 (additive, approved in #114): the store could not be read, so this is the live reading with the default
   * safe room, no storm session, and the hours at the stricter night limit. Absent when the store answered.
   */
  storeUnavailable: z.literal(true).optional(),
  /**
   * #342 (additive): with `storeUnavailable`, the hours are at the stricter older-person night limit. Absent in the
   * heating season, where that limit changes nothing (the hold keeps the heating minimum), and when the store answered.
   */
  stricterNightLimit: z.literal(true).optional(),
  /** #271 (additive, approved in #271): the safe room's limit in force now and what sets it, so a room above it is said so. */
  limitNow: z.strictObject({ limitC: CelsiusSchema, kind: SafeRoomLimitKindSchema }).optional(),
  /** #192 (additive): the safe room by its display name from the home profile, so a voice never says the id. */
  safeRoomName: z.string().min(1).max(80).optional(),
  /** #271 (additive, approved in #271): the fictional names of the occupants that have one in a demo or sandbox home. */
  people: z.array(z.strictObject({ role: RoleSchema, name: z.string().min(1).max(30) })).max(10).optional(),
  /**
   * #364 (additive): the battery runs out at `safeUntil` and the room then stays within its limits until `until`, from
   * the same hold; `limitC` is the limit it crosses there, absent when it stays within them to the end of the projection
   * ("at least until"). Absent when the battery is not what ends the safe hours, or in the heating season.
   */
  withinLimits: z.strictObject({ until: IsoDateTimeSchema, limitC: CelsiusSchema.optional() }).optional(),
  /**
   * (additive, approved 20 Oct): `safeUntil` is only the end of the projection, the battery outlasts it (the clear day),
   * so a screen says "at least until", as the voice does. Absent when the hold ends inside the projection.
   */
  safeUntilCapped: z.literal(true).optional(),
}).superRefine((s, ctx) => {
  if (s.withinLimits !== undefined && epochMs(s.withinLimits.until) <= epochMs(s.safeUntil)) {
    ctx.addIssue({ code: 'custom', path: ['withinLimits', 'until'], message: 'The room stays within its limits past the battery time, or the field is absent' });
  }
});
export type SafeRoomStatus = z.infer<typeof SafeRoomStatusSchema>;

/** No free text, recipient, handle or phone: the server fills a template from its own state. */
export const NotifyFamilyInputSchema = z.strictObject({
  transition: z.enum(MODEL_NOTIFIABLE_TRANSITIONS),
  /** Registered contact roles; all registered contacts when absent. */
  roles: z.array(RoleSchema).min(1).max(3).optional(),
});

export const NotifyFamilyOutputSchema = z.strictObject({
  sent: z.array(z.strictObject({ role: RoleSchema, channel: ContactChannelSchema })).max(3),
  skipped: z.array(z.strictObject({ role: RoleSchema, reason: z.enum(['not_registered', 'rate_limited']) })).max(3),
  /** The message as the model may see it: roles, never names. */
  preview: z.string().min(1).max(600),
});

/**
 * The answer of POST /phone/reply (approved in #24, Q5): the reply as recorded, and for check_status the
 * safe room as the phone shows it (no names, no handles: the status carries roles only).
 */
export const PhoneReplyOutputSchema = z.strictObject({
  recorded: FamilyReplySchema,
  status: SafeRoomStatusSchema.optional(),
});
export type PhoneReplyOutput = z.infer<typeof PhoneReplyOutputSchema>;
