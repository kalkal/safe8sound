import { ok, type ErrorEnvelope, type PlanId, type Result } from '@cold-reserve/contracts';
import type { Clock, StateStore } from '@cold-reserve/core';
import type { GuardVerdict } from '@cold-reserve/guard';

/**
 * Logs a guard refusal (queue item 5: "the guard blocked X proposals"). The log lists failed guarantees;
 * a refusal caused only by an unmet night recovery has none, so it is not logged there.
 */
export async function recordRejection(store: StateStore, verdict: GuardVerdict, clock: Clock, planId?: PlanId): Promise<Result<void, ErrorEnvelope>> {
  const failed = verdict.guarantees.filter((g) => !g.ok).map((g) => g.id);
  if (failed.length === 0) return ok(undefined);
  return store.recordGuardRejection({ at: new Date(clock.now()).toISOString(), failed, ...(planId === undefined ? {} : { planId }) });
}
