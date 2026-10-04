import { ApplyPlanInputSchema, ApplyPlanOutputSchema, PlanComfortInputSchema, PlanSchema, ReserveOutlookInputSchema, ReserveOutlookSchema } from '@cold-reserve/contracts';
import { nightWindowHours } from '@cold-reserve/guard';
import type { CapabilityModule } from '../../registry.js';
import { defineTool } from '../../tool.js';
import { applyPlan } from './apply-plan.js';
import { atHome, type ComfortPlanDeps } from './deps.js';
import { planComfort } from './plan-comfort.js';
import { reserveOutlook } from './reserve-outlook.js';
import { applySummary, outlookSummary, planSummary } from './summaries.js';

export { parseComfortPlanConfig, type ComfortPlanConfig } from './config.js';
export type { ComfortHome, ComfortPlanDeps } from './deps.js';

// `comfort-plan` capability module (plan §14.1, issue #19): propose a plan the guard accepts, apply it in
// a second step, and count the reserve in hours. On only for the homes the server knows.

export function comfortPlanModule(deps: ComfortPlanDeps): CapabilityModule {
  const night = deps.guard.nightRecovery;
  const summaryOptions = {
    nightWindowHours: nightWindowHours(night.windowStartHour, night.windowEndHour),
    nightStartHour: night.windowStartHour,
    nightEndHour: night.windowEndHour,
  };
  return {
    id: 'comfort-plan',
    enabledFor: (homeId) => deps.homes(homeId) !== undefined,
    tools: [
      defineTool({
        name: 'plan_comfort',
        title: 'Plan comfort',
        description:
          'Proposes a comfort plan for the coming hours (cool, heat, dry or auto) that the guard accepts: the five guarantees, ' +
          'the level ladder, the night recovery of the safe room and what would happen without the plan. Nothing changes in the home: ' +
          'confirm it with apply_plan. You may propose a setpoint and rooms; the guard then checks exactly that, and a refusal says why ' +
          'and what would be allowed. If the guard refuses your setpoint or rooms, the answer is the plan that holds instead, ready to apply, with a note of the refusal.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        input: PlanComfortInputSchema,
        output: PlanSchema,
        summarize: (plan) => {
          const profile = deps.homes(plan.homeId)?.profile;
          return planSummary(plan, {
            ...summaryOptions,
            timeZone: profile?.location.tz ?? 'UTC',
            roomNames: Object.fromEntries((profile?.rooms ?? []).map((r) => [r.id, r.name])),
          });
        },
        handler: (args, ctx) => planComfort(atHome(deps, ctx.homeId), args, ctx),
      }),
      defineTool({
        name: 'apply_plan',
        title: 'Apply plan',
        description:
          'Applies a proposed plan by its planId after the person confirmed it. Never in the same turn as plan_comfort: tell the person the plan and wait for their yes. ' +
          'The guard checks it again on the current state. ' +
          'Safe to retry: a plan already applied returns the same outcome. On the real home it is advice with manual steps.',
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        input: ApplyPlanInputSchema,
        output: ApplyPlanOutputSchema,
        summarize: applySummary,
        handler: (args, ctx) => applyPlan(atHome(deps, ctx.homeId), args, ctx),
      }),
      defineTool({
        name: 'get_reserve_outlook',
        title: 'Reserve outlook',
        description:
          'The battery counted in hours: at the current level, the same energy at Essential, and what the storm reserve alone would give.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        input: ReserveOutlookInputSchema,
        output: ReserveOutlookSchema,
        summarize: outlookSummary,
        handler: (_args, ctx) => reserveOutlook(atHome(deps, ctx.homeId), {}, ctx),
      }),
    ],
  };
}
