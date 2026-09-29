import { z } from 'zod';
import { EntityIdSchema, HomeIdSchema, IsoDateTimeSchema, epochMs } from './common.js';
import { GUARANTEE_IDS, GuaranteeResultSchema } from './guarantees.js';
import { HvacModeSchema } from './home.js';
import { DataOriginSchema } from './origin.js';
import { NightRecoverySchema, PlanWarningSchema } from './night-recovery.js';
import { LevelSchema, levelRank } from './pacing.js';
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
    /** What must be said even though the plan is accepted (optional, added 2026-09-29). */
    warnings: z.array(PlanWarningSchema).max(10).optional(),
  })
  .superRefine((plan, ctx) => {
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
