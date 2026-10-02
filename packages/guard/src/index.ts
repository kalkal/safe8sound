/** Composable guard constraints; every check returns a GuaranteeResult. The guard never modifies a plan. */
export const packageName = '@cold-reserve/guard';

export { GuardConfigSchema, parseGuardConfig, type GuardConfig } from './config.js';
export { counterfactualOf } from './counterfactual.js';
export { CONSTRAINTS, type Constraint } from './constraints.js';
export { buildContext, currentControls, projectFrom, reserveOf, type CandidatePlan, type GuardContext, type GuardInput } from './context.js';
export { runGuard, type GuardVerdict } from './guard.js';
export { evaluateNight, nightWindowHours } from './night.js';
export { rejectionOf } from './rejection.js';
export { nightCoolingLimit, safeUntil, type SafeLimit } from './safe-until.js';
