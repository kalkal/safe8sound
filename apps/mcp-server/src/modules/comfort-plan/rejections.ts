import type { HomeId, PlanId } from '@cold-reserve/contracts';
import type { Clock, Logger, StateStore } from '@cold-reserve/core';
import type { GuardVerdict } from '@cold-reserve/guard';

/**
 * Logs a guard refusal (queue item 5: "the guard blocked X proposals"). The log lists failed guarantees;
 * a refusal caused only by an unmet night recovery has none, so it is not logged there. A store that cannot
 * log it never hides the refusal from the model: the failure goes to the log with the request's correlation id
 * (audit L5, #111).
 */
export async function recordRejection(
  store: StateStore,
  verdict: GuardVerdict,
  deps: { clock: Clock; logger: Logger },
  request: { correlationId: string; homeId: HomeId },
  planId?: PlanId,
): Promise<void> {
  const failed = verdict.guarantees.filter((g) => !g.ok).map((g) => g.id);
  if (failed.length === 0) return;
  const recorded = await store.recordGuardRejection({ at: new Date(deps.clock.now()).toISOString(), failed, ...(planId === undefined ? {} : { planId }) });
  if (recorded.ok) return;
  deps.logger.log({
    ts: new Date(deps.clock.now()).toISOString(),
    level: 'warn',
    component: 'mcp-server',
    code: recorded.error.code,
    category: recorded.error.category,
    message: `The guard's refusal could not be logged in the store: ${recorded.error.message}`.slice(0, 500),
    correlationId: request.correlationId,
    homeId: request.homeId,
    details: { operation: 'recordGuardRejection', failed, ...(planId === undefined ? {} : { planId }) },
  });
}
