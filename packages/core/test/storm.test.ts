import { HvacUnitSchema, HomeProfileSchema, pct, type Level, type PacingState } from '@cold-reserve/contracts';
import { exampleHomeProfile } from '@cold-reserve/contracts/fixtures';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { batteryCapacityWh } from '../src/energy.js';
import { effectiveStormMode, holdPowerW, safeHours, safeUntil, stormBudget, stormStepDown } from '../src/storm.js';

const profile = HomeProfileSchema.parse(exampleHomeProfile());
const battery = profile.battery;
const unit = HvacUnitSchema.parse({
  id: 'split-bedroom-1',
  model: 'Hisense Easy Smart 12000 BTU',
  coolingKw: 3.2,
  inputKw: { min: 0.19, nominal: 0.97, max: 1.6 },
  modes: ['cool', 'dry', 'off'],
  controlPath: 'cloud',
});
const thermal = { rKPerKw: 10, cKwhPerK: 2 };
/** Longest horizon the safe hours are quoted for (config). */
const CAP_HOURS = 48;

describe('safeHours (plan §3.1): (SOC - floor) x capacity x efficiency / (split hold power + EPS base load)', () => {
  it('matches the formula written out by hand', () => {
    const expected = (((85 - 10) / 100) * batteryCapacityWh(battery) * battery.roundTripEff) / (400 + 150);
    expect(safeHours({ capHours: CAP_HOURS, battery, socPct: pct(85), holdW: 400, baseLoadW: 150 })).toBeCloseTo(expected, 9);
  });

  it('is zero at or below the floor', () => {
    expect(safeHours({ capHours: CAP_HOURS, battery, socPct: pct(10), holdW: 400, baseLoadW: 150 })).toBe(0);
    expect(safeHours({ capHours: CAP_HOURS, battery, socPct: pct(5), holdW: 400, baseLoadW: 150 })).toBe(0);
  });

  it('never decreases when the SOC rises, never increases when the load rises (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 3000, noNaN: true }),
        fc.double({ min: 0, max: 3000, noNaN: true }),
        (a, b, hold, base) => {
          const [low, high] = a <= b ? [a, b] : [b, a];
          const h = safeHours({ capHours: CAP_HOURS, battery, socPct: pct(low), holdW: hold, baseLoadW: base });
          expect(h).toBeGreaterThanOrEqual(0);
          expect(h).toBeLessThanOrEqual(CAP_HOURS);
          expect(safeHours({ capHours: CAP_HOURS, battery, socPct: pct(high), holdW: hold, baseLoadW: base })).toBeGreaterThanOrEqual(
            safeHours({ capHours: CAP_HOURS, battery, socPct: pct(low), holdW: hold, baseLoadW: base }),
          );
          expect(safeHours({ capHours: CAP_HOURS, battery, socPct: pct(high), holdW: hold + 100, baseLoadW: base })).toBeLessThanOrEqual(
            safeHours({ capHours: CAP_HOURS, battery, socPct: pct(high), holdW: hold, baseLoadW: base }),
          );
        },
      ),
    );
  });

  it('with no load at all (cool outside, nothing on), is the configured cap, never an error', () => {
    expect(safeHours({ capHours: CAP_HOURS, battery, socPct: pct(80), holdW: 0, baseLoadW: 0 })).toBe(CAP_HOURS);
  });

  it('never quotes more than the configured cap', () => {
    expect(safeHours({ capHours: CAP_HOURS, battery, socPct: pct(100), holdW: 0, baseLoadW: 1 })).toBe(CAP_HOURS);
  });

  it('turns hours into the time the safe room is covered until', () => {
    expect(safeUntil(Date.parse('2026-07-17T15:00:00Z'), 7.5)).toBe('2026-07-17T22:30:00.000Z');
  });
});

describe('holdPowerW: split power that keeps the safe room at its threshold', () => {
  it('is zero when outside is not warmer than the threshold', () => {
    expect(holdPowerW({ unit, thermal, outC: 26, thresholdC: 27, gainsW: 0 })).toEqual({ holdW: 0, canHold: true });
  });

  it('is the steady heat gain divided by the unit COP, at least the modulation minimum', () => {
    // gain = (31 - 27) K / 10 K/kW = 0.4 kW of heat; COP = 3.2 / 0.97; input = 0.4 / COP kW
    const expected = (0.4 / (3.2 / 0.97)) * 1000;
    expect(holdPowerW({ unit, thermal, outC: 31, thresholdC: 27, gainsW: 0 })).toEqual({ holdW: Math.max(expected, 190), canHold: true });
    const withGains = holdPowerW({ unit, thermal, outC: 31, thresholdC: 27, gainsW: 600 });
    expect(withGains.holdW).toBeCloseTo((1.0 / (3.2 / 0.97)) * 1000, 6);
  });

  it('can still hold at exactly the maximum input', () => {
    const cop = 3200 / 970;
    const atMax = holdPowerW({ unit, thermal, outC: 27, thresholdC: 27, gainsW: 1600 * cop });
    expect(atMax.canHold).toBe(true);
    expect(atMax.holdW).toBeCloseTo(1600, 6);
  });

  it('says when the unit cannot hold the threshold, at its maximum input', () => {
    expect(holdPowerW({ unit, thermal, outC: 60, thresholdC: 27, gainsW: 2000 })).toEqual({ holdW: 1600, canHold: false });
  });
});

describe('stormBudget: the reserve becomes the budget only when the grid is measured down (plan §1 principle 2)', () => {
  const reserveFloorPct = pct(50);

  it('with the grid up, only the energy above the reserve floor is budget', () => {
    const budget = stormBudget({ battery, socPct: pct(80), reserveFloorPct, gridAvailable: true });
    expect(budget.reserveUnlocked).toBe(false);
    expect(budget.budgetWh).toBeCloseTo(((80 - 50) / 100) * batteryCapacityWh(battery) * battery.roundTripEff, 6);
  });

  it('with the grid down, the reserve joins the budget down to the hardware floor', () => {
    const budget = stormBudget({ battery, socPct: pct(80), reserveFloorPct, gridAvailable: false });
    expect(budget.reserveUnlocked).toBe(true);
    expect(budget.budgetWh).toBeCloseTo(((80 - 10) / 100) * batteryCapacityWh(battery) * battery.roundTripEff, 6);
  });

  it('never unlocks the reserve while the grid is up, whatever the SOC or floor (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 100, noNaN: true }), fc.double({ min: 10, max: 100, noNaN: true }), (soc, floor) => {
        const budget = stormBudget({ battery, socPct: pct(soc), reserveFloorPct: pct(floor), gridAvailable: true });
        expect(budget.reserveUnlocked).toBe(false);
        expect(budget.budgetWh).toBeLessThanOrEqual(Math.max(0, ((soc - floor) / 100) * batteryCapacityWh(battery) * battery.roundTripEff) + 1e-6);
      }),
    );
  });
});

describe('effectiveStormMode (plan §9.4: "the storm is here" cannot unlock the reserve)', () => {
  it('turns active into prepare while the grid is up, with a reason', () => {
    expect(effectiveStormMode('active', true)).toEqual({ mode: 'prepare', reason: 'grid_still_up' });
    expect(effectiveStormMode('active', false)).toEqual({ mode: 'active', reason: 'grid_lost' });
    expect(effectiveStormMode('prepare', false)).toEqual({ mode: 'active', reason: 'grid_lost' });
    expect(effectiveStormMode('prepare', true)).toEqual({ mode: 'prepare', reason: 'requested' });
  });
});

describe('stormStepDown: one rung at a time, only when the current level cannot last until the horizon', () => {
  const ladder: Level[] = ['comfort', 'balanced', 'saver', 'essential'];
  const current: PacingState = { level: 'comfort', levelReason: 'user_choice', levelChangedAt: '2026-07-17T13:00:00.000Z' };
  const nowMs = Date.parse('2026-07-17T15:00:00Z');
  const hoursAt = { comfort: 4, balanced: 7, saver: 10, essential: 16 };

  it('steps down one rung, with the storm as the reason, when the current level runs out too early', () => {
    expect(stormStepDown({ current, ladder, hoursAt, hoursNeeded: 12, nowMs })).toEqual({
      level: 'balanced',
      levelReason: 'storm',
      levelChangedAt: '2026-07-17T15:00:00.000Z',
    });
  });

  it('stays when the current level lasts until the horizon, and never steps up during a storm', () => {
    expect(stormStepDown({ current, ladder, hoursAt, hoursNeeded: 3, nowMs })).toBe(current);
    const saver: PacingState = { ...current, level: 'saver' };
    expect(stormStepDown({ current: saver, ladder, hoursAt, hoursNeeded: 1, nowMs })).toBe(saver);
  });

  it('stops at the bottom of the ladder', () => {
    const essential: PacingState = { ...current, level: 'essential' };
    expect(stormStepDown({ current: essential, ladder, hoursAt, hoursNeeded: 30, nowMs })).toBe(essential);
  });

  it('stays when the current level lasts exactly until the horizon', () => {
    expect(stormStepDown({ current, ladder, hoursAt, hoursNeeded: 4, nowMs })).toBe(current);
  });

  it('reaches essential through every rung, one transition per call', () => {
    let state = current;
    const seen: Level[] = [state.level];
    for (let i = 0; i < 10; i++) {
      const next = stormStepDown({ current: state, ladder, hoursAt, hoursNeeded: 30, nowMs: nowMs + i * 60_000 });
      if (next === state) break;
      state = next;
      seen.push(state.level);
    }
    expect(seen).toEqual(ladder);
  });

  it('never skips a rung and never goes up, whatever the hours (property)', () => {
    const hours = fc.double({ min: 0, max: 48, noNaN: true });
    fc.assert(
      fc.property(fc.record({ comfort: hours, balanced: hours, saver: hours, essential: hours }), fc.array(hours, { maxLength: 12 }), (at, needs) => {
        let state = current;
        for (const [i, hoursNeeded] of needs.entries()) {
          const next = stormStepDown({ current: state, ladder, hoursAt: at, hoursNeeded, nowMs: nowMs + i * 60_000 });
          const step = ladder.indexOf(next.level) - ladder.indexOf(state.level);
          expect(step === 0 || step === 1).toBe(true);
          if (step === 1) expect(next.levelReason).toBe('storm');
          state = next;
        }
      }),
    );
  });
});
