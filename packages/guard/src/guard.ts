import type { GuaranteeResult, Pct } from '@cold-reserve/contracts';
import { CONSTRAINTS } from './constraints.js';
import { buildContext, type GuardInput } from './context.js';

// "The LLM proposes, the guard decides" (plan §9.2): the guard projects the plan with the same physics
// as the simulator, runs every constraint (no short-circuit) and never modifies the plan. A rejection
// always comes with the reason and the nearest allowed value, so the planner can re-plan.

export interface GuardVerdict {
  /** True when every guarantee holds. */
  readonly ok: boolean;
  readonly guarantees: GuaranteeResult[];
  readonly reserveWh: number;
  readonly reserveFloorSocPct: Pct;
}

export function runGuard(input: GuardInput): GuardVerdict {
  const ctx = buildContext(input);
  const guarantees = CONSTRAINTS.map((c) => c.check(ctx));
  return {
    ok: guarantees.every((g) => g.ok),
    guarantees,
    reserveWh: ctx.reserveWh,
    reserveFloorSocPct: ctx.reserveFloorSocPct,
  };
}
