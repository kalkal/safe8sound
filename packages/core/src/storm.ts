import { kilowatt, kilowattToWatt, type HvacUnit, type Level, type PacingState, type Pct, type Room } from '@cold-reserve/contracts';
import type { BatterySpec } from './energy.js';
import { usableWh } from './reserve.js';

// Storm logic of plan §3.1 and §4bis, pure and deterministic: safe hours, the split power that holds
// the safe-room threshold, the reserve as budget only with the grid down, and the storm step-down.

const HOUR_MS = 3_600_000;

/**
 * Safe hours: (SOC - floor) x capacity x round-trip efficiency / (hold power + EPS base load), quoted
 * up to `capHours` (config: the longest horizon we speak about). With no load at all (cool outside,
 * nothing on) the battery lasts beyond any horizon, so the answer is the cap, never an error.
 * The floor defaults to the hardware one: in a storm the reserve is the budget.
 */
export function safeHours(input: { battery: BatterySpec; socPct: Pct; holdW: number; baseLoadW: number; capHours: number; floorPct?: Pct }): number {
  const loadW = Math.max(0, input.holdW) + Math.max(0, input.baseLoadW);
  if (loadW === 0) return input.capHours;
  const hours = usableWh(input.battery, input.socPct, input.floorPct ?? input.battery.minSocHwPct) / loadW;
  return Math.min(Math.max(0, hours), input.capHours);
}

/** The time the safe room is covered until, as ISO 8601. */
export const safeUntil = (nowMs: number, hours: number): string => new Date(nowMs + hours * HOUR_MS).toISOString();

export interface HoldPower {
  /** Electrical input of the split in W. */
  readonly holdW: number;
  /** False when even the maximum input cannot keep the room at the threshold. */
  readonly canHold: boolean;
}

/**
 * Steady-state split power that keeps a room at `thresholdC`: the heat that comes in through the
 * walls, (outC - thresholdC) / R, plus internal gains, divided by the unit COP at nominal load.
 * A running split never draws less than its modulation minimum, nor more than its maximum input.
 */
export function holdPowerW(input: { unit: HvacUnit; thermal: Room['thermal']; outC: number; thresholdC: number; gainsW: number }): HoldPower {
  const wallGainW = kilowattToWatt(kilowatt(Math.max(0, input.outC - input.thresholdC) / input.thermal.rKPerKw));
  const gainW = wallGainW + Math.max(0, input.gainsW);
  if (gainW <= 0) return { holdW: 0, canHold: true };
  const nominalInputW = kilowattToWatt(input.unit.inputKw.nominal);
  const cop = kilowattToWatt(input.unit.coolingKw) / nominalInputW;
  const minW = kilowattToWatt(input.unit.inputKw.min);
  const maxW = kilowattToWatt(input.unit.inputKw.max);
  const neededW = gainW / cop;
  // A milliwatt of tolerance: exactly the maximum input still holds.
  if (neededW > maxW + 1e-3) return { holdW: maxW, canHold: false };
  if (neededW >= maxW) return { holdW: maxW, canHold: true };
  return { holdW: Math.max(neededW, minW), canHold: true };
}

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
