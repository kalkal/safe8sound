import { z } from 'zod';
import { EntityIdSchema, HomeIdSchema, IsoDateTimeSchema, epochMs } from './common.js';
import { GUARANTEE_IDS, GuaranteeResultSchema } from './guarantees.js';
import { HvacModeSchema } from './home.js';
import { ErrorCodeSchema } from './errors.js';
import { DataOriginSchema } from './origin.js';
import { CorrelationIdSchema } from './correlation.js';
import { CounterfactualSchema } from './counterfactual.js';
import { NightRecoverySchema, PlanWarningSchema } from './night-recovery.js';
import { LevelSchema, levelRank } from './pacing.js';
import { LocationIdSchema } from './sandbox-settings.js';
import { ForecastConfidenceSchema } from './snapshot.js';
import { CelsiusSchema, PctSchema, WattHourSchema } from './units.js';

export const PLAN_SCHEMA_VERSION = 1;

export const PlanIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/)
  .brand<'PlanId'>();
export type PlanId = z.infer<typeof PlanIdSchema>;

export const PlanStatusSchema = z.enum(['proposed', 'applied', 'expired']);
/** What the person asked for; "auto" lets the planner choose (not the split's auto mode). */
export const PlanGoalSchema = z.enum(['cool', 'heat', 'dry', 'auto']);

/** One rung of the ladder the person confirms with the plan (plan §4bis). */
export const LevelStepSchema = z.strictObject({
  level: LevelSchema,
  /** Offset on the chosen comfort setpoint, in kelvin (+1 = one degree warmer when cooling). */
  setpointOffsetK: z.number().min(-10).max(10),
  fansOn: z.boolean(),
  preferredModes: z.array(HvacModeSchema).min(1),
  roomIds: z.array(EntityIdSchema),
});
export type LevelStep = z.infer<typeof LevelStepSchema>;

export const PlanStepSchema = z.strictObject({
  ts: IsoDateTimeSchema,
  roomId: EntityIdSchema,
  hvacMode: HvacModeSchema,
  setpointC: CelsiusSchema,
  preset: z.string().regex(/^[a-z_]{1,24}$/).optional(),
  fanOn: z.boolean(),
  level: LevelSchema,
  batteryTargetSocPct: PctSchema,
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

/**
 * Zero-energy actions on the last-resort card (approved in #160). Only actions backed by the public-health
 * sources in docs/heat-advice.md; the fan only below 35 °C, the guard rule already in place.
 */
export const LAST_RESORT_ACTIONS = ['close_curtains', 'drink_water', 'fan_below_35c'] as const;
export const LastResortActionSchema = z.enum(LAST_RESORT_ACTIONS);
export type LastResortAction = z.infer<typeof LastResortActionSchema>;

/** Why a room got the solar surplus, in the order it got it (approved in #203). */
export const SurplusReasonSchema = z.enum(['safe_room', 'occupied', 'occupied_tonight']);

export const PlanSurplusSchema = z
  .strictObject({
    /** The window the projection would export in, in home time. */
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema,
    /** Export of the same plan without the surplus use, minus the export with it: kept at home. */
    keptKWh: z.number().nonnegative(),
    /** The rooms in the order the surplus went: the safe room first, then the hottest above target. */
    rooms: z
      .array(z.strictObject({ roomId: EntityIdSchema, setpointC: CelsiusSchema, reason: SurplusReasonSchema, aboveTargetK: z.number() }))
      .min(1)
      .max(12),
    /**
     * The comfort each room's aboveTargetK is measured from (optional, additive): the card can say
     * "now 30.9 °C, 6.9 °C above the 24 °C comfort", as the voice does.
     */
    comfortC: CelsiusSchema.optional(),
  })
  .superRefine((s, ctx) => {
    if (epochMs(s.to) <= epochMs(s.from)) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The window ends after it starts' });
    if (new Set(s.rooms.map((r) => r.roomId)).size !== s.rooms.length) ctx.addIssue({ code: 'custom', path: ['rooms'], message: 'Each room appears once' });
  });

/**
 * A household tip from the solar surplus (#219, approved in #219): the longest load that fits the
 * window where the plan, battery full, still exports enough. Advice only, never a plan step, never a brand. When
 * `probable` (low forecast confidence) the text gives no end time.
 */
export const PlanHouseholdTipSchema = z
  .strictObject({
    load: z.enum(['washing', 'cooking']),
    cycle: z.enum(['eco', 'normal', 'quick']).optional(),
    windowFrom: IsoDateTimeSchema,
    windowTo: IsoDateTimeSchema,
    probable: z.boolean(),
  })
  .superRefine((t, ctx) => {
    if (epochMs(t.windowTo) <= epochMs(t.windowFrom)) ctx.addIssue({ code: 'custom', path: ['windowTo'], message: 'The window ends after it starts' });
    if ((t.load === 'washing') !== (t.cycle !== undefined)) ctx.addIssue({ code: 'custom', path: ['cycle'], message: 'A cycle for the washing machine only, and always' });
  });

export const PlanSchema = z
  .strictObject({
    schemaVersion: z.literal(PLAN_SCHEMA_VERSION),
    id: PlanIdSchema,
    homeId: HomeIdSchema,
    status: PlanStatusSchema,
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    horizonAt: IsoDateTimeSchema,
    goal: PlanGoalSchema,
    ladder: z.array(LevelStepSchema).min(1),
    steps: z.array(PlanStepSchema),
    reserveWh: WattHourSchema,
    guarantees: z.array(GuaranteeResultSchema),
    forecastConfidence: ForecastConfidenceSchema,
    confidenceReason: z.string().min(1).max(200),
    sourceOrigin: DataOriginSchema,
    /** True on the real home during the hackathon: the plan is advice, nothing is commanded. */
    advisoryOnly: z.boolean(),
    /** Night recovery of the safe room, when the plan covers part of a night (optional, added 2026-09-29). */
    nightRecovery: NightRecoverySchema.optional(),
    /**
     * The guard's SOC floor for the storm reserve: with the grid up the battery never goes below it. Same axis as
     * `steps[].batteryTargetSocPct`, for the reserve line of the plan card (optional, added 2026-09-30, approved in #19).
     */
    reserveFloorSocPct: PctSchema.optional(),
    /**
     * Whether the grid was up when the plan was made. With the grid down the reserve is in use and there is no
     * floor; absent on older plans, where a missing floor means "unknown" (optional, added 2026-09-30, approved in #19).
     */
    gridAvailable: z.boolean().optional(),
    /** The same scenario with no plan and with the naive plan, in the safe room (optional, added 2026-09-29). */
    counterfactual: CounterfactualSchema.optional(),
    /** What must be said even though the plan is accepted (optional, added 2026-09-29). */
    warnings: z.array(PlanWarningSchema).max(10).optional(),
    /**
     * The model proposed a setpoint or rooms and the guard refused them: this plan is the planner's own that holds,
     * and this is the refusal it answers, its code and message (optional, additive, approved in #202).
     */
    refusedProposal: z.strictObject({ code: ErrorCodeSchema, message: z.string().min(1).max(300) }).optional(),
    /** The turn that proposed the plan (#230, optional, additive, approved in #230): apply_plan by the agent in that same turn is refused. */
    proposedInTurn: CorrelationIdSchema.optional(),
    /**
     * Present when no plan keeps the safe room within its limits until the next recharge: this is the safest
     * one, proposed so the person hears until when the room is safe and why (optional, added 2026-10-01,
     * approved in #19). It is applied only after a second, explicit confirmation (approved in #160).
     */
    /**
     * Where the solar surplus went instead of the grid (optional, added 2026-10-04, approved in #203): on grid,
     * cooling only, with the battery unable to take more. The guard checked the whole plan with it.
     */
    surplus: PlanSurplusSchema.optional(),
    /** A good time to run the washing machine or cook on the solar surplus (optional, additive, approved in #219). */
    householdTip: PlanHouseholdTipSchema.optional(),
    lastResort: z
      .strictObject({
        safeUntil: IsoDateTimeSchema,
        safeHours: z.number().nonnegative(),
        /** What ends the safe hours: the battery runs out, or the room leaves its temperature or humidity limits. */
        limitedBy: z.enum(['battery', 'temperature', 'humidity']),
        /**
         * The honest window, whole or not at all (optional, added 2026-10-02, approved in #160): from `safeUntil`
         * on, the warmest point past its limit (the coldest when heating) is `worstC` at `worstAt`; `comfortLimitC`
         * is the limit in force then (at night the night-recovery threshold when lower). It says nothing of the time
         * before `safeUntil`.
         */
        comfortLimitC: CelsiusSchema.optional(),
        worstC: CelsiusSchema.optional(),
        worstAt: IsoDateTimeSchema.optional(),
        /**
         * Present when the safe hours end because the limit came down at `safeUntil` (the night threshold) with the
         * room inside the earlier limit and above the new one: that new limit (optional, added 2026-10-03, #166).
         */
        loweredLimitC: CelsiusSchema.optional(),
        /**
         * When the battery ends the safe hours: the first moment the room then goes past the limit in force, from the
         * same projection, between `safeUntil` and `worstAt` (optional, added 2026-10-06, approved in #272). Absent with
         * the window absent too: the room stays inside its limit until the end of the projection.
         */
        limitCrossedAt: IsoDateTimeSchema.optional(),
        /** The limit in force at `limitCrossedAt`, the one the room crosses there (optional, only with it, #272 review). */
        limitCrossedC: CelsiusSchema.optional(),
        /** Zero-energy actions for the card, from public-health guidance (optional, added 2026-10-02, approved in #160). */
        actions: z.array(LastResortActionSchema).max(LAST_RESORT_ACTIONS.length).optional(),
        /** The home's place, so the card names the number to call there: 911 in Houston, 112 in Italy (optional, additive, #376). */
        place: LocationIdSchema.optional(),
      })
      .superRefine((lr, ctx) => {
        const window = [lr.comfortLimitC, lr.worstC, lr.worstAt];
        if (window.some((v) => v !== undefined) && window.some((v) => v === undefined)) {
          ctx.addIssue({ code: 'custom', path: ['worstAt'], message: 'The window is given whole: comfortLimitC, worstC and worstAt together' });
        }
        // Past the limit: above it when cooling, below it when heating (the plan carries no season, so either side).
        if (lr.worstC !== undefined && lr.worstC === lr.comfortLimitC) {
          ctx.addIssue({ code: 'custom', path: ['worstC'], message: 'A window is given only when the room goes past its limit' });
        }
        if (lr.worstAt !== undefined && epochMs(lr.worstAt) < epochMs(lr.safeUntil)) {
          ctx.addIssue({ code: 'custom', path: ['worstAt'], message: 'The worst point comes at or after the end of the safe hours' });
        }
        if (lr.loweredLimitC !== undefined && (lr.limitedBy !== 'temperature' || lr.worstC === undefined)) {
          ctx.addIssue({ code: 'custom', path: ['loweredLimitC'], message: 'A lowered limit ends the safe hours on temperature, with its window' });
        }
        if (
          lr.limitCrossedAt !== undefined &&
          (lr.limitedBy !== 'battery' ||
            lr.worstAt === undefined ||
            epochMs(lr.limitCrossedAt) < epochMs(lr.safeUntil) ||
            epochMs(lr.limitCrossedAt) > epochMs(lr.worstAt))
        ) {
          ctx.addIssue({ code: 'custom', path: ['limitCrossedAt'], message: 'The crossing comes after the battery runs out and by the worst point, with its window' });
        }
        if (lr.limitCrossedC !== undefined && lr.limitCrossedAt === undefined) {
          ctx.addIssue({ code: 'custom', path: ['limitCrossedC'], message: 'The limit crossed comes with the time it is crossed' });
        }
        if (lr.actions !== undefined && new Set(lr.actions).size !== lr.actions.length) {
          ctx.addIssue({ code: 'custom', path: ['actions'], message: 'Each action appears once' });
        }
      })
      .optional(),
  })
  .superRefine((plan, ctx) => {
    if (plan.gridAvailable === false && plan.reserveFloorSocPct !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['reserveFloorSocPct'], message: 'With the grid down the reserve is in use: there is no floor' });
    }
    if (epochMs(plan.expiresAt) <= epochMs(plan.createdAt)) {
      ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'A plan expires after it is created' });
    }
    const ids = plan.guarantees.map((g) => g.id);
    if (ids.length !== GUARANTEE_IDS.length || GUARANTEE_IDS.some((id) => !ids.includes(id))) {
      ctx.addIssue({ code: 'custom', path: ['guarantees'], message: 'Every guarantee appears exactly once' });
    }
    const ranks = plan.ladder.map((step) => levelRank(step.level));
    if (ranks.some((rank, i) => i > 0 && rank <= (ranks[i - 1] ?? -1))) {
      ctx.addIssue({ code: 'custom', path: ['ladder'], message: 'Ladder goes from comfort down, without repeats' });
    }
    const warningCodes: readonly string[] = (plan.warnings ?? []).map((w) => w.code);
    if (plan.lastResort !== undefined && plan.guarantees.every((g) => g.ok)) {
      ctx.addIssue({ code: 'custom', path: ['lastResort'], message: 'A last resort is proposed only when a guarantee fails' });
    }
    if (plan.lastResort !== undefined && !warningCodes.includes('last_resort_plan')) {
      ctx.addIssue({ code: 'custom', path: ['warnings'], message: 'A last-resort plan needs its warning' });
    }
    if (plan.nightRecovery?.status === 'infeasible' && !warningCodes.includes('night_recovery_infeasible')) {
      ctx.addIssue({ code: 'custom', path: ['warnings'], message: 'An infeasible night recovery needs its warning' });
    }
    const allowed = new Set(plan.ladder.map((step) => step.level));
    plan.steps.forEach((step, i) => {
      if (!allowed.has(step.level)) {
        ctx.addIssue({ code: 'custom', path: ['steps', i, 'level'], message: 'Step level is not in the ladder' });
      }
    });
  });
export type Plan = z.infer<typeof PlanSchema>;
