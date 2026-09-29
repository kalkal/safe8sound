import { GUARANTEE_IDS, pct, type GuaranteeResult } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { rejectionOf, type GuardVerdict } from '../src/index.js';

const ok = (id: GuaranteeResult['id']): GuaranteeResult => ({ id, ok: true, reason: 'Holds.' });
const verdict = (guarantees: GuaranteeResult[]): GuardVerdict => ({
  ok: false,
  guarantees,
  reserveWh: 4000,
  reserveFloorSocPct: pct(36),
});
const all = (failing?: GuaranteeResult) => GUARANTEE_IDS.map((id) => (failing?.id === id ? failing : ok(id)));

describe('rejectionOf', () => {
  it('is undefined when everything holds', () => {
    expect(rejectionOf(verdict(all()))).toBeUndefined();
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
});
