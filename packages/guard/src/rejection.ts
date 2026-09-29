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
    };
    return toolError(CODE[failed.id], failed.reason, { details });
  }
  return undefined;
}
