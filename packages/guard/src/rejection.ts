import { toolError, type ErrorCode, type ErrorDetails, type ErrorEnvelope, type GuaranteeId, type TempUnit } from '@cold-reserve/contracts';
import { inputTemp, temp } from './display.js';
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

/** The refusal for a verdict, its words in the unit the person chose (#306); its details stay in °C. */
export function rejectionOf(verdict: GuardVerdict, unit: TempUnit = 'C'): ErrorEnvelope | undefined {
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
    const value = failed.nearestAllowed;
    const allowed =
      value === undefined
        ? ''
        : failed.unit === 'C' && unit === 'F'
          ? ` Nearest allowed: ${inputTemp(value, 'F')}.`
          : ` Nearest allowed: ${value.toString()}${failed.unit === undefined ? '' : ` ${failed.unit}`}.`;
    return toolError(CODE[failed.id], `${failed.reason}${allowed}`.slice(0, 300), { details });
  }
  const night = verdict.nightRecovery;
  if (night?.status === 'unmet') {
    const minutes = (h: number) => Math.round(h * 60);
    // With no hour required (a plan that sees only the end of the night) only the heat budget can fail.
    if (night.requiredHours === 0) {
      return toolError('night_recovery_unmet', 'The safe room would stay too warm for too long tonight to sleep well.', { details: { roomId: night.roomId } });
    }
    const overBudget = night.heatIndexDegreeHoursAbove26_7 > night.budgetDegreeHours;
    return toolError(
      'night_recovery_unmet',
      `The safe room would be cool enough to sleep (at or below ${temp(night.thresholdC, unit)}) for only ${night.achievedHours.toString()} of the ${night.requiredHours.toString()} night hours${overBudget ? ', and too warm for too long' : ''}.`,
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
