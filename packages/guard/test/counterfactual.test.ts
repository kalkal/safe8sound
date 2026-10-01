import { CounterfactualSchema, celsius, type HvacMode } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { counterfactualOf } from '../src/counterfactual.js';
import { H, MIN, T0, config, input, plan, snapshot, step } from './support.js';

// Mutation testing runs the properties with fewer cases (FC_RUNS); CI and local runs use the full count.
const runs = (n: number): number => Number(process.env['FC_RUNS'] ?? n);

describe('counterfactualOf (feature queue item 2)', () => {
  it('gives the three lines for the safe room, valid against the contract', () => {
    const c = counterfactualOf(input());
    expect(CounterfactualSchema.parse(c).roomId).toBe('bedroom-1');
  });

  it('without a plan the bedroom gets hotter than with ours, and later at night it is not cooler', () => {
    const c = counterfactualOf(input());
    expect(c?.scenarios.noPlan.peakTempC).toBeGreaterThan(c?.scenarios.plan.peakTempC ?? Infinity);
    expect(c?.scenarios.noPlan.hoursAtOrBelowThreshold).toBeLessThanOrEqual(c?.scenarios.plan.hoursAtOrBelowThreshold ?? 0);
  });

  it('off grid the naive plan runs only what the EPS powers: the occupied living room gets nothing', () => {
    // The daughter is in the living room, so the naive plan asks to cool it too. Off grid only the EPS
    // circuits are powered (#19): the naive night is the same as cooling the safe room alone. Until
    // 2026-10-01 the living room's split ran on the battery as well and emptied it early.
    const base = snapshot({ gridAvailable: false, socPct: 30 });
    const rooms = base.rooms.map((r) => (r.id === 'living' ? { ...r, occupants: ['daughter'] } : r));
    const safeAlone = input({ snapshot: { ...base, rooms }, plan: plan([step({ setpointC: 25, targetPct: 10, fanOn: false })]) });
    const c = counterfactualOf(safeAlone);
    expect(c?.scenarios.naive).toEqual(c?.scenarios.plan);
  });

  it('rounds for people: temperatures to 0.1 °C, hours and degree-hours to 0.01', () => {
    const c = counterfactualOf(input());
    for (const line of Object.values(c?.scenarios ?? {})) {
      expect(Math.round(line.peakTempC * 10)).toBeCloseTo(line.peakTempC * 10, 9);
      expect(Math.round(line.heatIndexDegreeHours * 100)).toBeCloseTo(line.heatIndexDegreeHours * 100, 9);
      expect(Math.round(line.hoursAtOrBelowThreshold * 100)).toBeCloseTo(line.hoursAtOrBelowThreshold * 100, 9);
    }
  });

  it('is left out outside the cooling season (its lines measure heat and night cooling)', () => {
    expect(counterfactualOf(input({ season: 'heating' }))).toBeUndefined();
    expect(counterfactualOf(input({ season: 'neutral' }))).toBeUndefined();
  });

  it('is undefined when the safe room has no reading', () => {
    const s = snapshot();
    expect(counterfactualOf(input({ snapshot: { ...s, rooms: s.rooms.filter((r) => r.id !== 'bedroom-1') } }))).toBeUndefined();
  });

  it('the naive plan keeps what runs now; with nothing running it cools at the comfort setpoint', () => {
    const base = snapshot({ gridAvailable: false, socPct: 30 });
    const drying = { ...base, rooms: base.rooms.map((r) => (r.id === 'bedroom-1' ? { ...r, hvac: { mode: 'dry' as const, setpointC: celsius(27) }, fanOn: true } : r)) };
    const keeps = counterfactualOf(input({ snapshot: drying }))?.scenarios.naive;
    const comfort = counterfactualOf(input({ snapshot: base }))?.scenarios.naive;
    // Dry at 27 °C holds the room warmer than cooling at the 25 °C comfort setpoint.
    expect(keeps?.hoursAtOrBelowThreshold).toBeLessThan(comfort?.hoursAtOrBelowThreshold ?? 0);
  });

  it('a split reported as off counts as nothing running: the naive plan then cools at comfort', () => {
    const base = snapshot({ gridAvailable: false, socPct: 30 });
    const off = { ...base, rooms: base.rooms.map((r) => (r.id === 'bedroom-1' ? { ...r, hvac: { mode: 'off' as const, setpointC: celsius(27) } } : r)) };
    expect(counterfactualOf(input({ snapshot: off }))?.scenarios.naive).toEqual(counterfactualOf(input({ snapshot: base }))?.scenarios.naive);
  });

  it('property: "no plan" is never better than our plan on heat-index degree-hours', () => {
    const fast = config((c) => ({ ...c, projection: { ...c.projection, stepMinutes: 30 } }));
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(10, 11, 100), fc.double({ min: 10, max: 100, noNaN: true })),
        fc.boolean(),
        fc.array(
          fc.record({
            roomId: fc.constantFrom('bedroom-1', 'living', 'study'),
            mode: fc.constantFrom<HvacMode>('cool', 'dry', 'fan_only', 'off'),
            setpointC: fc.integer({ min: 16, max: 30 }),
            offsetMin: fc.integer({ min: 0, max: 600 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        (socPct, gridAvailable, steps) => {
          const c = counterfactualOf(
            input({
              config: fast,
              snapshot: snapshot({ socPct, gridAvailable }),
              plan: plan(steps.map((s) => step({ ...s, atMs: T0 + s.offsetMin * MIN, targetPct: 10 })), T0 + 12 * H),
            }),
          );
          expect(c?.scenarios.noPlan.heatIndexDegreeHours ?? 0).toBeGreaterThanOrEqual((c?.scenarios.plan.heatIndexDegreeHours ?? 0) - 0.01);
        },
      ),
      { numRuns: runs(10_000) },
    );
  }, 180_000);
});
