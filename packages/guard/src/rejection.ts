import { toolError, type ErrorCode, type ErrorDetails, type ErrorEnvelope, type GuaranteeId } from '@cold-reserve/contracts';
import type { GuardVerdict } from './guard.js';

// A rejected plan becomes a guard_rejection error envelope (docs/error-handling.md §2): the model reads
// the reason and the nearest allowed value and re-plans. The first failing guarantee, in contract
// order, names the error; the verdict itself still lists them all.

const CODE: Record<GuaranteeId, ErrorCode> = {
  storm_reserve: 'storm_reserve_violated',
  inverter_limit: 'inverter_limit_exceeded',
  battery_power: 'battery_power_exceeded',
  safe_room_comfort: 'safe_room_comfort_violated',
  pacing_on_track: 'pacing_off_track',
};

export function rejectionOf(verdict: GuardVerdict): ErrorEnvelope | undefined {
  const failed = verdict.guarantees.find((g) => !g.ok);
  if (failed !== undefined) {
    const details: ErrorDetails = {
      guarantee: failed.id,
      ...(failed.measured === undefined ? {} : { measured: failed.measured }),
      ...(failed.limit === undefined ? {} : { limit: failed.limit }),
      ...(failed.nearestAllowed === undefined ? {} : { nearestAllowed: failed.nearestAllowed }),
      ...(failed.unit === undefined ? {} : { unit: failed.unit }),
      // The whole verdict, so the receipt card can show all five rows next to the refusal (#186).
      guarantees: verdict.guarantees,
    };
    // The model reads only this text (not the details): it carries the value the guard would accept.
    const allowed = failed.nearestAllowed === undefined ? '' : ` Nearest allowed: ${failed.nearestAllowed.toString()}${failed.unit === undefined ? '' : ` ${failed.unit}`}.`;
    return toolError(CODE[failed.id], `${failed.reason}${allowed}`.slice(0, 300), { details });
  }
  const night = verdict.nightRecovery;
  if (night?.status === 'unmet') {
    const minutes = (h: number) => Math.round(h * 60);
    const heat = `${night.heatIndexDegreeHoursAbove26_7.toString()} heat-index degree-hours above 26.7 °C`;
    const budget = `${night.budgetDegreeHours.toString()} allowed`;
    // With no hour required (a plan that sees only the end of the night) only the heat budget can fail.
    if (night.requiredHours === 0) {
      return toolError('night_recovery_unmet', `The plan lets the heat in the safe room reach ${heat} tonight, over the ${budget}.`, { details: { roomId: night.roomId } });
    }
    const overBudget = night.heatIndexDegreeHoursAbove26_7 > night.budgetDegreeHours;
    return toolError(
      'night_recovery_unmet',
      `The plan keeps the safe room at or below ${night.thresholdC.toString()} °C for ${night.achievedHours.toString()} of the ${night.requiredHours.toString()} night hours it can reach${overBudget ? `, and lets the heat reach ${heat}, over the ${budget}` : ''}.`,
      {
        details: {
          roomId: night.roomId,
          measured: minutes(night.achievedHours),
          limit: minutes(night.requiredHours),
          nearestAllowed: minutes(night.requiredHours),
          unit: 'min',
        },
      },
    );
  }
  return undefined;
}
