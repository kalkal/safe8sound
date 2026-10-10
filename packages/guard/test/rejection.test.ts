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
      message: 'Too much. Nearest allowed: 5 W.',
      retryable: false,
      // The whole verdict rides along, so the receipt can show all five rows (#186).
      details: { guarantee: id, measured: 7, limit: 5, nearestAllowed: 5, unit: 'W', guarantees: all(failing) },
    });
  });

  it('leaves out the numbers a guarantee does not have', () => {
    const failing: GuaranteeResult = { id: 'safe_room_comfort', ok: false, reason: 'No reading.' };
    expect(rejectionOf(verdict(all(failing)))).toMatchObject({ message: 'No reading.', details: { guarantee: 'safe_room_comfort' } });
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

  it('an unmet night over the heat budget names the heat as well', () => {
    const n = { ...night('unmet'), heatIndexDegreeHoursAbove26_7: 7.2 };
    expect(rejectionOf(verdict(all(), n))?.message).toBe(
      'The plan keeps the safe room at or below 26 °C for 2.5 of the 6 night hours it can reach, and lets the heat reach 7.2 heat-index degree-hours above 26.7 °C, over the 4 allowed.',
    );
  });

  it('in °F (#306): the threshold in °F and the heat as °F-hours, the same amount (x1.8)', () => {
    const n = { ...night('unmet'), heatIndexDegreeHoursAbove26_7: 7.2 };
    expect(rejectionOf(verdict(all(), n), 'F')?.message).toBe(
      'The plan keeps the safe room at or below 78.8 °F for 2.5 of the 6 night hours it can reach, and lets the heat reach 13 heat-index °F-hours above 80.1 °F, over the 7.2 allowed.',
    );
  });

  it('in °F an amount just over the budget is never said as equal to it: the amount is rounded up (#306 review)', () => {
    // 4.01 degree-hours are 7.218 °F-hours: said 7.3, over the 7.2 allowed, never "7.2 over the 7.2".
    const n = { ...night('unmet'), heatIndexDegreeHoursAbove26_7: 4.01 };
    expect(rejectionOf(verdict(all(), n), 'F')?.message).toContain('lets the heat reach 7.3 heat-index °F-hours above 80.1 °F, over the 7.2 allowed.');
  });

  it('with no hour required, an unmet night is the heat budget alone, without hours', () => {
    const n = { ...night('unmet'), requiredHours: 0, achievedHours: 0.5, heatIndexDegreeHoursAbove26_7: 7.2 };
    expect(rejectionOf(verdict(all(), n))).toEqual({
      code: 'night_recovery_unmet',
      category: 'guard_rejection',
      message: 'The plan lets the heat in the safe room reach 7.2 heat-index degree-hours above 26.7 °C tonight, over the 4 allowed.',
      retryable: false,
      details: { roomId: 'bedroom-1' },
    });
  });
});
