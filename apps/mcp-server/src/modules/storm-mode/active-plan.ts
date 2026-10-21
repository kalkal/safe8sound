import type { ActivePlan, StormSession } from '@cold-reserve/contracts';
import { localIso } from '@cold-reserve/core';

/**
 * Whether the plan applied last still runs (owner, 21 Oct: the rest tile says "Plan active"): from its apply until its
 * horizon, unless a storm started since (the storm mode replaces it). `nowMs` is the home's domain time (the reading's),
 * the time it runs until is on the home's own clock. The store keeps which plan; this is the one rule of when it runs.
 */
export function activePlanNow(o: { active: ActivePlan | undefined; session: Pick<StormSession, 'startedAt'> | undefined; nowMs: number; timeZone: string }): { planId: ActivePlan['planId']; until: string } | undefined {
  const { active, session } = o;
  if (active === undefined || o.nowMs >= Date.parse(active.until)) return undefined;
  if (session !== undefined && Date.parse(session.startedAt) >= Date.parse(active.appliedAt)) return undefined;
  return { planId: active.planId, until: localIso(Date.parse(active.until), o.timeZone) };
}
