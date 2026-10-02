import { z } from 'zod';
import { EntityIdSchema, IsoDateTimeSchema } from './common.js';
import { PlanGoalSchema, PlanIdSchema, PlanSchema } from './plan.js';
import { CelsiusSchema } from './units.js';

// I/O of the comfort-plan tools (plan_comfort, apply_plan, get_reserve_outlook), approved in #19. They live
// here so that the MCP server, the web simulator and the cards validate the same shapes.
// plan_comfort returns a Plan; get_reserve_outlook returns a ReserveOutlook.

export const PlanComfortInputSchema = z.strictObject({
  goal: PlanGoalSchema,
  /** Optional: the setpoint the model proposes; the guard checks exactly that plan. */
  setpointC: CelsiusSchema.optional(),
  /** Optional: the rooms the model proposes to serve. */
  roomIds: z.array(EntityIdSchema).min(1).max(12).optional(),
});
export type PlanComfortInput = z.infer<typeof PlanComfortInputSchema>;

/** The token of the first step of a last-resort apply: random, single-use, bound to the plan (approved in #160). */
export const LastResortTokenSchema = z.string().regex(/^lr_[A-Za-z0-9_-]{22,64}$/);

export const ApplyPlanInputSchema = z.strictObject({
  planId: PlanIdSchema,
  /** The second, explicit yes to a last-resort plan: the token the first step returned (optional, approved in #160). */
  lastResortToken: LastResortTokenSchema.optional(),
});
export type ApplyPlanInput = z.infer<typeof ApplyPlanInputSchema>;

export const ReserveOutlookInputSchema = z.strictObject({});

/** One line of the manual-control card (plan §11.6): what to set by hand in a room. */
export const ManualInstructionSchema = z.strictObject({
  roomId: EntityIdSchema,
  text: z.string().min(1).max(120),
});
export type ManualInstruction = z.infer<typeof ManualInstructionSchema>;

export const ApplyPlanOutputSchema = z
  .strictObject({
    plan: PlanSchema,
    /** True when this planId was already applied: the stored outcome is returned (idempotent). */
    alreadyApplied: z.boolean(),
    /** True on the real home during the hackathon: nothing is commanded (plan §9.2). */
    advisoryOnly: z.boolean(),
    /** One line per room when advisory, empty otherwise. */
    manualInstructions: z.array(ManualInstructionSchema).max(12),
    /**
     * The first step of a last-resort apply: nothing is applied yet, the person must say yes again and the
     * model sends this token back (optional, added 2026-10-02, approved in #160).
     */
    confirmation: z.strictObject({ token: LastResortTokenSchema, expiresAt: IsoDateTimeSchema }).optional(),
  })
  .superRefine((o, ctx) => {
    if (!o.advisoryOnly && o.manualInstructions.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['manualInstructions'], message: 'Manual instructions come only with advice' });
    }
    if (o.confirmation !== undefined && (o.plan.lastResort === undefined || o.plan.status !== 'proposed')) {
      ctx.addIssue({ code: 'custom', path: ['confirmation'], message: 'A confirmation comes only with a last-resort plan not applied yet' });
    }
  });
export type ApplyPlanOutput = z.infer<typeof ApplyPlanOutputSchema>;
