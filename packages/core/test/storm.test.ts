import { HomeProfileSchema, pct, type Level, type PacingState } from '@cold-reserve/contracts';
import { exampleHomeProfile } from '@cold-reserve/contracts/fixtures';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { batteryCapacityWh } from '../src/energy.js';
import { effectiveStormMode, stormBudget, stormStepDown } from '../src/storm.js';

const profile = HomeProfileSchema.parse(exampleHomeProfile());
const battery = profile.battery;
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
