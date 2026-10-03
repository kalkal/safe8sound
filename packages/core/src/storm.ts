import type { Level, PacingState, Pct } from '@cold-reserve/contracts';
import type { BatterySpec } from './energy.js';
import { usableWh } from './reserve.js';

// Storm logic of plan §3.1 and §4bis, pure and deterministic: the reserve as budget only with the grid
// down, and the storm step-down. The safe hours are the guard's hold of the safe room (holdSafeRoom, #24).

export interface StormBudget {
  readonly budgetWh: number;
  /** True only when the grid is measured (or scenario-declared) down. */
  readonly reserveUnlocked: boolean;
}

/** With the grid up the budget stops at the reserve floor; with the grid down the reserve joins it. */
export function stormBudget(input: { battery: BatterySpec; socPct: Pct; reserveFloorPct: Pct; gridAvailable: boolean }): StormBudget {
  if (input.gridAvailable) return { budgetWh: usableWh(input.battery, input.socPct, input.reserveFloorPct), reserveUnlocked: false };
  return { budgetWh: usableWh(input.battery, input.socPct), reserveUnlocked: true };
}

export type StormMode = 'prepare' | 'active';
export type StormModeReason = 'requested' | 'grid_still_up' | 'grid_lost';

/**
 * `active` needs a measured grid loss: "the storm is here" said to the agent cannot unlock the
 * reserve (plan §9.4). A measured grid loss makes the storm active whatever was asked.
 */
export function effectiveStormMode(requested: StormMode, gridAvailable: boolean): { mode: StormMode; reason: StormModeReason } {
  if (!gridAvailable) return { mode: 'active', reason: 'grid_lost' };
  return requested === 'active' ? { mode: 'prepare', reason: 'grid_still_up' } : { mode: 'prepare', reason: 'requested' };
}

/**
 * During a storm the level only goes down, one rung per call, and only when the current level would
 * run out before the horizon (`hoursAt[level] < hoursNeeded`). Returns the same object when nothing changes.
 */
export function stormStepDown(input: {
  current: PacingState;
  ladder: readonly Level[];
  hoursAt: Readonly<Record<Level, number>>;
  hoursNeeded: number;
  nowMs: number;
}): PacingState {
  const index = input.ladder.indexOf(input.current.level);
  const lower = input.ladder[index + 1];
  if (index < 0 || lower === undefined) return input.current;
  if (input.hoursAt[input.current.level] >= input.hoursNeeded) return input.current;
  return { level: lower, levelReason: 'storm', levelChangedAt: new Date(input.nowMs).toISOString() };
}
