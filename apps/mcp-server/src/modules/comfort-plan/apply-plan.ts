import { err, isFullyLive, ok, toolError, type ApplyPlanInput, type ApplyPlanOutput, type ErrorEnvelope, type HomeProfile, type Plan, type Result } from '@cold-reserve/contracts';
import { epsBaseLoadW } from '@cold-reserve/core';
import { rejectionOf, runGuard } from '@cold-reserve/guard';
import type { ToolContext } from '../../tool.js';
import type { ComfortPlanDeps } from './deps.js';
import { guardFrame, loadInputs } from './plan-comfort.js';
import { recordRejection } from './rejections.js';

// apply_plan, the second phase (plan §9.2, §9.4):
// 1. an already applied planId returns the stored outcome (idempotent: agents and bridges retry);
// 2. on the real home, a plan built on simulated data is refused;
// 3. the guard revalidates the plan on the current state: a refusal writes nothing but the refusal log;
// 4. F5's conditional write (`status = proposed AND now < expiresAt`) applies it exactly once.
// During the hackathon the real home is read-only: the plan is stored as advice with manual instructions.

export async function applyPlan(deps: ComfortPlanDeps, input: ApplyPlanInput, ctx: ToolContext): Promise<Result<ApplyPlanOutput, ErrorEnvelope>> {
  const home = deps.homes(ctx.homeId);
  if (home === undefined) return err(toolError('home_not_found', 'This client is not linked to a configured home.'));
  const store = deps.storeFor(ctx.homeId);
  const stored = await store.getPlan(input.planId);
  if (!stored.ok) return stored;
  if (stored.value.status === 'applied') return ok(outcome(stored.value, true, home.profile));

  if (home.readOnly && !isFullyLive(stored.value.sourceOrigin)) {
    return err(
      toolError('simulated_plan_on_real_home', 'This plan was built on simulated data, so it cannot be applied to the real home.', {
        details: { planId: input.planId },
      }),
    );
  }

  const loaded = await loadInputs(deps, ctx);
  if (!loaded.ok) return loaded;
  const { snapshot, forecast, profile, preferences } = loaded.value;
  if (!snapshot.gridAvailable) {
    const eps = epsBaseLoadW(profile);
    if (!eps.ok) return eps;
  }
  const verdict = runGuard({
    plan: stored.value,
    snapshot,
    forecast,
    profile,
    preferences,
    ...guardFrame(deps, stored.value.goal, loaded.value),
    model: deps.model,
    config: deps.guard,
  });
  if (!verdict.ok) {
    const recorded = await recordRejection(store, verdict, deps.clock, input.planId);
    if (!recorded.ok) return recorded;
    return err(rejectionOf(verdict) ?? toolError('unexpected_error', 'The guard refused the plan without a reason.'));
  }

  const applied = await store.applyPlan(input.planId);
  if (!applied.ok) return applied;
  return ok(outcome(applied.value.plan, applied.value.alreadyApplied, profile));
}

function outcome(plan: Plan, alreadyApplied: boolean, profile: HomeProfile): ApplyPlanOutput {
  return { plan, alreadyApplied, advisoryOnly: plan.advisoryOnly, manualInstructions: plan.advisoryOnly ? manualInstructions(plan, profile) : [] };
}

/** One line per room from the plan's first setting of it (plan §11.6, manual control card). */
function manualInstructions(plan: Plan, profile: HomeProfile): { roomId: string; text: string }[] {
  const first = new Map<string, Plan['steps'][number]>();
  for (const s of [...plan.steps].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) if (!first.has(s.roomId)) first.set(s.roomId, s);
  return [...first.values()].slice(0, 12).map((s) => {
    const name = profile.rooms.find((r) => r.id === s.roomId)?.name ?? s.roomId;
    const what = s.hvacMode === 'off' ? 'off' : `${s.hvacMode} at ${s.setpointC.toString()} °C`;
    return { roomId: s.roomId, text: `${name}: ${what}${s.fanOn ? ', fan on' : ''}`.slice(0, 120) };
  });
}
