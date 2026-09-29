import { GUARANTEE_IDS, celsius, pct, type GuaranteeResult, type NightRecovery } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { rejectionOf, type GuardVerdict } from '../src/index.js';

const ok = (id: GuaranteeResult['id']): GuaranteeResult => ({ id, ok: true, reason: 'Holds.' });
const verdict = (guarantees: GuaranteeResult[], nightRecovery?: NightRecovery): GuardVerdict => ({
  ok: false,
  guarantees,
  ...(nightRecovery === undefined ? {} : { nightRecovery }),
  warnings: [],
  reserveWh: 4000,
  reserveFloorSocPct: pct(36),
});
const all = (failing?: GuaranteeResult) => GUARANTEE_IDS.map((id) => (failing?.id === id ? failing : ok(id)));

const night = (status: NightRecovery['status']): NightRecovery => ({
  roomId: 'bedroom-1',
  mode: 'standard',
  thresholdC: celsius(26),
  window: { start: '2026-07-15T20:00:00.000Z', end: '2026-07-16T05:00:00.000Z' },
  requiredHours: 6,
  achievedHours: 2.5,
  status,
  heatIndexDegreeHoursAbove26_7: 1,
  budgetDegreeHours: 4,
  ...(status === 'infeasible' ? { bestAchievableHours: 3 } : {}),
});

describe('rejectionOf', () => {
  it('is undefined when everything holds', () => {
    expect(rejectionOf(verdict(all()))).toBeUndefined();
    expect(rejectionOf(verdict(all(), night('met')))).toBeUndefined();
    expect(rejectionOf(verdict(all(), night('infeasible')))).toBeUndefined();
  });

  it.each([
    ['storm_reserve', 'storm_reserve_violated'],
    ['inverter_limit', 'inverter_limit_exceeded'],
    ['battery_power', 'battery_power_exceeded'],
    ['safe_room_comfort', 'safe_room_comfort_violated'],
    ['pacing_on_track', 'pacing_off_track'],
  ] as const)('names a failing %s as %s, with every number of the guarantee', (id, code) => {
    const failing: GuaranteeResult = { id, ok: false, reason: 'Too much.', measured: 7, limit: 5, nearestAllowed: 5, unit: 'W' };
    expect(rejectionOf(verdict(all(failing)))).toEqual({
      code,
      category: 'guard_rejection',
      message: 'Too much.',
      retryable: false,
      details: { guarantee: id, measured: 7, limit: 5, nearestAllowed: 5, unit: 'W' },
    });
  });

  it('leaves out the numbers a guarantee does not have', () => {
    const failing: GuaranteeResult = { id: 'safe_room_comfort', ok: false, reason: 'No reading.' };
    expect(rejectionOf(verdict(all(failing)))?.details).toEqual({ guarantee: 'safe_room_comfort' });
  });

  it('takes the first failing guarantee in contract order', () => {
    const guarantees = all().map((g) => (g.id === 'pacing_on_track' || g.id === 'inverter_limit' ? { ...g, ok: false } : g));
    expect(rejectionOf(verdict(guarantees))?.code).toBe('inverter_limit_exceeded');
  });

  it('rejects an unmet night in minutes, naming the room', () => {
    expect(rejectionOf(verdict(all(), night('unmet')))).toEqual({
      code: 'night_recovery_unmet',
      category: 'guard_rejection',
      message: 'The plan keeps the safe room at or below 26 °C for 2.5 of the 6 night hours it can reach.',
      retryable: false,
      details: { roomId: 'bedroom-1', measured: 150, limit: 360, nearestAllowed: 360, unit: 'min' },
    });
  });
});
