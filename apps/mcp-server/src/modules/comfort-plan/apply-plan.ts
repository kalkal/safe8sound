import {
  epochMs,
  err,
  formatTemp,
  isFullyLive,
  ok,
  toolError,
  type ApplyPlanInput,
  type ApplyPlanOutput,
  type ErrorEnvelope,
  type HomeProfile,
  type Plan,
  type Result,
  type TempUnit,
} from '@cold-reserve/contracts';
import { epsBaseLoadW, invalidLastResortToken, type StateStore } from '@cold-reserve/core';
import { rejectionOf, runGuard, type GuardVerdict } from '@cold-reserve/guard';
import { homeDetail, isSandbox } from '../../sandbox-log.js';
import { localIso } from '@cold-reserve/core';
import type { ToolContext } from '../../tool.js';
import { newLastResortToken, planHash, sha256Hex } from './confirm-token.js';
import { alertFamily } from './family-alert.js';
import type { ComfortPlanDeps } from './deps.js';
import { HARD_LIMITS, guardFrame, loadInputs } from './plan-comfort.js';
import { recordRejection } from './rejections.js';

// apply_plan, the second phase (plan §9.2, §9.4):
// 1. an already applied planId returns the stored outcome (idempotent: agents and bridges retry);
// 2. on the real home, a plan built on simulated data is refused;
// 3. the guard revalidates the plan on the current state: a refusal writes nothing but the refusal log;
// 4. F5's conditional write (`status = proposed AND now < expiresAt`) applies it exactly once.
// During the hackathon the real home is read-only: the plan is stored as advice with manual instructions.
//
// A last resort (#160) holds the hard limits but not every comfort guarantee. On a home that is commanded it
// takes two explicit yeses: a plain apply only returns a token bound to the plan, and only the call that brings
// that token back applies it. On the real home it stays advice, so its manual steps come at once.

export async function applyPlan(deps: ComfortPlanDeps, input: ApplyPlanInput, ctx: ToolContext): Promise<Result<ApplyPlanOutput, ErrorEnvelope>> {
  const home = deps.homes(ctx.homeId);
  if (home === undefined) return err(toolError('home_not_found', 'This client is not linked to a configured home.'));
  const store = deps.storeFor(ctx.homeId, { correlationId: ctx.correlationId });
  const stored = await store.getPlan(input.planId);
  if (!stored.ok) return stored;
  if (stored.value.status === 'applied') return ok(outcome(stored.value, true, home.profile, home.units));
  // The person confirms before the agent applies (#230): in the turn that proposed the plan, nobody has answered
  // yet. A card tap carries no turn, so it is always the person's own yes.
  if (ctx.turnId !== undefined && stored.value.proposedInTurn === ctx.turnId) {
    const refused = toolError('confirmation_required', 'Not applied: the person has not confirmed yet. Tell them the plan and ask; call apply_plan only after they say yes.', {
      details: { planId: input.planId },
    });
    // A validation error is not logged by the handler: this one is, once, because the model skipped the person.
    deps.logger.log({
      ts: new Date(deps.clock.now()).toISOString(),
      level: 'warn',
      component: 'mcp-server',
      message: 'apply_plan came in the turn that proposed the plan: refused until the person confirms.',
      correlationId: ctx.correlationId,
      ...(isSandbox(ctx.homeId) ? {} : { homeId: ctx.homeId }),
      code: refused.code,
      category: refused.category,
      details: { event: 'apply_without_confirmation', planId: input.planId, ...homeDetail(ctx.homeId) },
    });
    return err(refused);
  }
  const lastResort = stored.value.lastResort !== undefined;
  if (input.lastResortToken !== undefined && !lastResort) return err(invalidLastResortToken());

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
    // The guard's words in the unit the sandbox chose (#306).
    displayUnit: home.units ?? 'C',
  });
  if (!verdict.ok && !(lastResort && holdsHardLimits(verdict))) {
    await recordRejection(store, verdict, deps, { correlationId: ctx.correlationId, homeId: ctx.homeId }, input.planId);
    return err(rejectionOf(verdict, home.units ?? 'C') ?? toolError('unexpected_error', 'The safety check refused the plan without a reason.'));
  }

  if (lastResort && !home.readOnly) {
    if (input.lastResortToken === undefined) return issueConfirmation(deps, store, stored.value, profile, ctx);
    const used = await store.consumeLastResortConfirmation(stored.value.id, sha256Hex(input.lastResortToken), deps.clock.now());
    if (!used.ok) {
      // A used token on a plan applied meanwhile (a retry, a concurrent second yes): the idempotent outcome.
      const now = await store.getPlan(stored.value.id);
      return now.ok && now.value.status === 'applied' ? ok(outcome(now.value, true, profile, home.units)) : used;
    }
    if (used.value.planHash !== planHash(stored.value)) return err(invalidLastResortToken());
    logLastResort(deps, ctx, stored.value, 'last_resort_confirmed', 'Last-resort plan confirmed by a second yes.');
  }

  // Expiry on the home's domain time (its scenario clock); the store's own clock keeps only the retention (#175).
  const applied = await store.applyPlan(input.planId, deps.clock.now());
  if (!applied.ok) return applied;
  // The plan is applied, but the store could not record it as the active one (review of #498: best-effort): said here,
  // with the turn's id, never as a failure; the rest tile then just does not say "Plan active".
  if (applied.value.activePlanUnsaved === true) {
    deps.logger.log({
      ts: new Date(deps.clock.now()).toISOString(),
      level: 'warn',
      component: 'mcp-server',
      message: 'The plan is applied but could not be recorded as the active one.',
      correlationId: ctx.correlationId,
      code: 'store_unavailable',
      category: 'dependency_unavailable',
      ...(isSandbox(ctx.homeId) ? {} : { homeId: ctx.homeId }),
      details: { event: 'active_plan_unsaved', planId: applied.value.plan.id, ...homeDetail(ctx.homeId) },
    });
  }
  if (lastResort && !applied.value.alreadyApplied) {
    logLastResort(deps, ctx, applied.value.plan, 'last_resort_applied', 'Last-resort plan applied.');
    const alert = await alertFamily(deps.notifier, { plan: applied.value.plan, profile, preferences, snapshot, nowMs: deps.clock.now(), unit: home.units ?? 'C' });
    const counts = { sent: alert.sent, failed: alert.failed };
    // Counts only: never a name, a handle or the text of the message.
    deps.logger.log({
      ts: new Date(deps.clock.now()).toISOString(),
      level: 'info',
      component: 'mcp-server',
      message: `Last-resort family alert: ${String(alert.sent)} of ${String(alert.sent + alert.failed)} sent.`,
      correlationId: ctx.correlationId,
      ...(isSandbox(ctx.homeId) ? {} : { homeId: ctx.homeId }),
      details: { event: 'last_resort_alert_sent', planId: applied.value.plan.id, sent: alert.sent, total: alert.sent + alert.failed, ...homeDetail(ctx.homeId) },
    });
    // The plan stays applied: a failed alert is said in the log and to the person, never swallowed.
    if (alert.failure !== undefined) {
      deps.logger.log({
        ts: new Date(deps.clock.now()).toISOString(),
        level: 'warn',
        component: 'mcp-server',
        message: `Last-resort family alert not delivered (${String(alert.sent)} sent).`,
        correlationId: ctx.correlationId,
        code: alert.failure.code,
        category: alert.failure.category,
        ...(isSandbox(ctx.homeId) ? {} : { homeId: ctx.homeId }),
        details: { event: 'last_resort_alert_failed', planId: applied.value.plan.id, ...homeDetail(ctx.homeId) },
      });
    }
    return ok({ ...outcome(applied.value.plan, false, profile, home.units), familyAlert: counts });
  }
  return ok(outcome(applied.value.plan, applied.value.alreadyApplied, profile, home.units));
}

/** A last resort fails a comfort guarantee by definition; it is applied only while the hard limits hold. */
const holdsHardLimits = (verdict: GuardVerdict): boolean => verdict.guarantees.every((g) => g.ok || !HARD_LIMITS.includes(g.id));

/**
 * The first yes to a last resort: nothing is applied. A fresh token, of which only the hash is stored with
 * the plan's hash, valid for the configured minutes and never past the plan; a new one replaces the earlier.
 */
async function issueConfirmation(deps: ComfortPlanDeps, store: StateStore, plan: Plan, profile: HomeProfile, ctx: ToolContext): Promise<Result<ApplyPlanOutput, ErrorEnvelope>> {
  const nowMs = deps.clock.now();
  // Down to the whole second: the time told (localIso has no milliseconds) is exactly the time stored.
  const expiresAtMs = Math.floor(Math.min(epochMs(plan.expiresAt), nowMs + deps.config.lastResortConfirmMinutes * 60_000) / 1000) * 1000;
  if (expiresAtMs <= nowMs) return err(toolError('plan_expired', 'This plan has expired; ask for a new one.', { details: { planId: plan.id } }));
  const token = newLastResortToken();
  const saved = await store.saveLastResortConfirmation({ planId: plan.id, tokenHash: sha256Hex(token), planHash: planHash(plan), expiresAt: new Date(expiresAtMs).toISOString() }, nowMs);
  if (!saved.ok) return saved;
  logLastResort(deps, ctx, plan, 'last_resort_confirmation_issued', 'Last-resort plan: first yes, confirmation issued.');
  return ok({ plan, alreadyApplied: false, advisoryOnly: false, manualInstructions: [], confirmation: { token, expiresAt: localIso(expiresAtMs, profile.location.tz) } });
}

type LastResortEvent = 'last_resort_confirmation_issued' | 'last_resort_confirmed' | 'last_resort_applied';

/** One info line per step of a last resort (#160): the plan id and the step, never the token. */
function logLastResort(deps: ComfortPlanDeps, ctx: ToolContext, plan: Plan, event: LastResortEvent, message: string): void {
  deps.logger.log({
    ts: new Date(deps.clock.now()).toISOString(),
    level: 'info',
    component: 'mcp-server',
    message,
    correlationId: ctx.correlationId,
    ...(isSandbox(ctx.homeId) ? {} : { homeId: ctx.homeId }),
    details: { event, planId: plan.id, ...homeDetail(ctx.homeId) },
  });
}

function outcome(plan: Plan, alreadyApplied: boolean, profile: HomeProfile, unit: TempUnit = 'C'): ApplyPlanOutput {
  return { plan, alreadyApplied, advisoryOnly: plan.advisoryOnly, manualInstructions: plan.advisoryOnly ? manualInstructions(plan, profile, unit) : [] };
}

/** One line per room from the plan's first setting of it (plan §11.6, manual control card), in the home's unit (#306). */
function manualInstructions(plan: Plan, profile: HomeProfile, unit: TempUnit): { roomId: string; text: string }[] {
  const first = new Map<string, Plan['steps'][number]>();
  for (const s of [...plan.steps].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) if (!first.has(s.roomId)) first.set(s.roomId, s);
  return [...first.values()].slice(0, 12).map((s) => {
    const name = profile.rooms.find((r) => r.id === s.roomId)?.name ?? s.roomId;
    const what = s.hvacMode === 'off' ? 'off' : `${s.hvacMode} at ${formatTemp(s.setpointC, unit)}`;
    return { roomId: s.roomId, text: `${name}: ${what}${s.fanOn ? ', fan on' : ''}`.slice(0, 120) };
  });
}
