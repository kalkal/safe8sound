import type { GuaranteeResult, NightRecovery, Pct, PlanWarning } from '@cold-reserve/contracts';
import { CONSTRAINTS } from './constraints.js';
import { buildContext, type GuardInput } from './context.js';
import { dryAirWarning } from './dry-air.js';
import { humidAirWarning } from './humid-air.js';
import { evaluateNight } from './night.js';

// "The LLM proposes, the guard decides" (plan §9.2): the guard projects the plan with the same physics
// as the simulator, runs every constraint (no short-circuit) and never modifies the plan. A rejection
// always comes with the reason and the nearest allowed value, so the planner can re-plan.

export interface GuardVerdict {
  /** True when every guarantee holds and the night recovery is not unmet. */
  readonly ok: boolean;
  readonly guarantees: GuaranteeResult[];
  readonly nightRecovery?: NightRecovery;
  readonly warnings: PlanWarning[];
  readonly reserveWh: number;
  readonly reserveFloorSocPct: Pct;
}

export function runGuard(input: GuardInput): GuardVerdict {
  const ctx = buildContext(input);
  const guarantees = CONSTRAINTS.map((c) => c.check(ctx));
  const night = evaluateNight(ctx);
  const dryAir = dryAirWarning(ctx);
  // "No heat danger" is said only when the safe room passes its check (#285 review): never next to a refusal or a
  // last resort built on that refusal.
  const roomSafe = guarantees.find((g) => g.id === 'safe_room_comfort')?.ok === true;
  const humidAir = roomSafe ? humidAirWarning(ctx) : undefined;
  return {
    ok: guarantees.every((g) => g.ok) && night.nightRecovery?.status !== 'unmet',
    guarantees,
    ...(night.nightRecovery === undefined ? {} : { nightRecovery: night.nightRecovery }),
    warnings: [...night.warnings, ...(dryAir === undefined ? [] : [dryAir]), ...(humidAir === undefined ? [] : [humidAir])],
    reserveWh: ctx.reserveWh,
    reserveFloorSocPct: ctx.reserveFloorSocPct,
  };
}

