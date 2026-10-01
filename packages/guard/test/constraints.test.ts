import { HomeProfileSchema, PreferencesSchema, celsius, pct, watt, type GuaranteeId, type GuaranteeResult, type Season } from '@cold-reserve/contracts';
import { exampleHomeProfile, examplePreferences } from '@cold-reserve/contracts/fixtures';
import type { ProjectionPoint } from '@cold-reserve/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CONSTRAINTS } from '../src/constraints.js';
import { dryAirWarning } from '../src/dry-air.js';
import type { GuardContext } from '../src/context.js';
import { H, MIN, T0, input, plan, step } from './support.js';

// Each constraint on a hand-built context: exact numbers, boundaries and reasons.

// Mutation testing runs the properties with fewer cases (FC_RUNS); CI and local runs use the full count.
const runs = (n: number): number => Number(process.env['FC_RUNS'] ?? n);

const zero = {
  pvUsedW: watt(0), curtailedW: watt(0), chargeW: watt(0), dischargeW: watt(0), gridImportW: watt(0), gridExportW: watt(0),
  gridW: watt(0), servedLoadW: watt(0), unservedLoadW: watt(0), nextSocPct: pct(50), pvW: watt(0), loadW: watt(0), hvacW: watt(0), fansW: watt(0),
};

function point(atMin: number, o: { soc?: number; loadW?: number; pvW?: number; unservedW?: number; tempC?: number; rh?: number; room?: string } = {}): ProjectionPoint {
  return {
    ms: T0 + atMin * MIN,
    socPct: pct(o.soc ?? 60),
    rooms: [{ id: o.room ?? 'bedroom-1', tempC: celsius(o.tempC ?? 25), humidityPct: pct(o.rh ?? 50) }],
    flows: { ...zero, loadW: watt(o.loadW ?? 500), pvW: watt(o.pvW ?? 0), unservedLoadW: watt(o.unservedW ?? 0) },
  };
}

function ctx(o: Partial<GuardContext> & { season?: Season; snapshotSoc?: number } = {}): GuardContext {
  // The default 40-60 % humidity band of the example preferences.
  const base = input({ season: o.season ?? 'cooling', preferences: PreferencesSchema.parse(examplePreferences()) });
  const withSoc = o.snapshotSoc === undefined ? base : { ...base, snapshot: { ...base.snapshot, batterySocPct: pct(o.snapshotSoc) } };
  return {
    input: o.input ?? withSoc,
    nowMs: T0,
    horizonMs: T0 + 10 * H,
    gridAvailable: true,
    reserveWh: 4000,
    reserveFloorSocPct: pct(36),
    dischargeFloorPct: pct(36),
    acLimitW: 6000,
    points: [point(0)],
    targets: [],
    ...o,
  };
}

const check = (id: GuaranteeId, c: GuardContext): GuaranteeResult => {
  const constraint = CONSTRAINTS.find((x) => x.id === id);
  if (constraint === undefined) throw new Error(id);
  return constraint.check(c);
};
const at = (h: number, p: number) => ({ ms: T0 + h * H, pct: p });

describe('storm_reserve', () => {
  it('holds at the floor, and quotes the reserve and the lowest battery level', () => {
    expect(check('storm_reserve', ctx({ targets: [at(0, 40), at(1, 36)], points: [point(0, { soc: 50 }), point(60, { soc: 45 })] }))).toEqual({
      id: 'storm_reserve',
      ok: true,
      reason: 'Keeps 4.0 kWh for a storm: the battery stays at or above 36 %.',
      measured: 36,
      limit: 36,
      nearestAllowed: 36,
      unit: '%',
    });
  });

  it('fails just below the floor and names both numbers', () => {
    const r = check('storm_reserve', ctx({ targets: [at(0, 35.9)], points: [point(0, { soc: 50 })] }));
    expect(r).toMatchObject({ ok: false, measured: 35.9, limit: 36, nearestAllowed: 36 });
    expect(r.reason).toBe('The plan takes the battery to 35.9 %, below the 36 % kept for a storm (4.0 kWh).');
  });

  it('compares the plan’s targets with the floor exactly (a hair below fails)', () => {
    expect(check('storm_reserve', ctx({ targets: [at(0, 36 - 1e-9)], points: [point(0, { soc: 50 })] })).ok).toBe(false);
    expect(check('storm_reserve', ctx({ targets: [at(0, 36)], points: [point(0, { soc: 50 })] })).ok).toBe(true);
  });

  it('a floor just above a tenth gives the next tenth, and re-planning with it passes', () => {
    const floor = pct(35.80000001);
    const r = check('storm_reserve', ctx({ reserveFloorSocPct: floor, targets: [at(0, 35.8)], points: [point(0, { soc: 50 })] }));
    expect(r).toMatchObject({ ok: false, nearestAllowed: 35.9, limit: 35.9 });
    expect(check('storm_reserve', ctx({ reserveFloorSocPct: floor, targets: [at(0, r.nearestAllowed ?? 0)], points: [point(0, { soc: 50 })] })).ok).toBe(true);
  });

  it('property: re-planning with the nearest allowed value always passes storm_reserve', () => {
    const floors = fc.oneof(fc.constantFrom(35.8, 35.80000001, 36, 10, 99.99999, 100), fc.double({ min: 10, max: 100, noNaN: true }));
    fc.assert(
      fc.property(floors, (f) => {
        const floor = pct(f);
        const low = check('storm_reserve', ctx({ reserveFloorSocPct: floor, targets: [at(0, 0)], points: [point(0, { soc: 100 })] }));
        expect(low.ok).toBe(false);
        const again = check('storm_reserve', ctx({ reserveFloorSocPct: floor, targets: [at(0, low.nearestAllowed ?? 0)], points: [point(0, { soc: 100 })] }));
        expect(again.ok).toBe(true);
      }),
      { numRuns: runs(10_000) },
    );
  });

  it('fails when the projection goes below the floor even with good targets', () => {
    const r = check('storm_reserve', ctx({ targets: [at(0, 50)], points: [point(0, { soc: 50 }), point(60, { soc: 30 })] }));
    expect(r).toMatchObject({ ok: false, measured: 30 });
  });

  it('lets a battery already below the floor stay where it is, never lower', () => {
    expect(check('storm_reserve', ctx({ snapshotSoc: 20, points: [point(0, { soc: 20 })] })).ok).toBe(true);
    expect(check('storm_reserve', ctx({ snapshotSoc: 20, points: [point(0, { soc: 19.9 })] })).ok).toBe(false);
  });

  it('rounds the floor up for the limit, so re-planning with it passes', () => {
    expect(check('storm_reserve', ctx({ reserveFloorSocPct: pct(35.82), points: [point(0, { soc: 50 })] }))).toMatchObject({ limit: 35.9, nearestAllowed: 35.9 });
    expect(check('storm_reserve', ctx({ reserveFloorSocPct: pct(35.8), points: [point(0, { soc: 50 })] }))).toMatchObject({ limit: 35.8 });
  });

  it('with the grid down only says so', () => {
    expect(check('storm_reserve', ctx({ gridAvailable: false, targets: [at(0, 5)] }))).toEqual({
      id: 'storm_reserve',
      ok: true,
      reason: 'The grid is down: the reserve is now the budget for the safe room.',
    });
  });
});

describe('inverter_limit', () => {
  it('holds at the limit exactly, on grid', () => {
    expect(check('inverter_limit', ctx({ points: [point(0, { loadW: 3000 }), point(5, { loadW: 6000 })] }))).toEqual({
      id: 'inverter_limit',
      ok: true,
      reason: 'Peak load 6.0 kW, within the 6.0 kW the inverter delivers on grid.',
      measured: 6000,
      limit: 6000,
      nearestAllowed: 6000,
      unit: 'W',
    });
  });

  it('fails one watt above, off grid, and says what to do', () => {
    const r = check('inverter_limit', ctx({ gridAvailable: false, acLimitW: 5000, points: [point(0, { loadW: 5001 }), point(5, { loadW: 100 })] }));
    expect(r).toMatchObject({ ok: false, measured: 5001, limit: 5000 });
    expect(r.reason).toBe('Peak load 5.0 kW is above the 5.0 kW the inverter delivers off grid: fewer rooms at once, safe room first.');
  });
});

describe('battery_power', () => {
  const profile = HomeProfileSchema.parse(exampleHomeProfile());
  it('off grid, measures what PV does not cover', () => {
    expect(check('battery_power', ctx({ gridAvailable: false, points: [point(0, { loadW: 3000, pvW: 1000 }), point(5, { loadW: 800, pvW: 2000 })] }))).toEqual({
      id: 'battery_power',
      ok: true,
      reason: 'The battery delivers at most 2.0 kW, within its 5.0 kW.',
      measured: 2000,
      limit: profile.battery.maxDischargeW,
      nearestAllowed: profile.battery.maxDischargeW,
      unit: 'W',
    });
  });

  it('on grid, the grid takes the excess', () => {
    expect(check('battery_power', ctx({ points: [point(0, { loadW: 9000 })] }))).toMatchObject({ ok: true, measured: 0 });
  });

  it('holds at the rating and fails above it', () => {
    expect(check('battery_power', ctx({ gridAvailable: false, points: [point(0, { loadW: 5000 })] })).ok).toBe(true);
    const r = check('battery_power', ctx({ gridAvailable: false, points: [point(0, { loadW: 5001 })] }));
    expect(r).toMatchObject({ ok: false, measured: 5001 });
    expect(r.reason).toBe('The plan needs 5.0 kW from the battery; it delivers at most 5.0 kW.');
  });

  it('reads the trajectory between consecutive targets, keeping the worst step', () => {
    // 40 % of 15.33 kWh in one hour = 6.1 kW, then a small rise that must not hide it.
    const r = check('battery_power', ctx({ targets: [at(0, 90), at(1, 90), at(2, 50), at(3, 51)] }));
    expect(r.ok).toBe(false);
    expect(r.measured).toBe(6133);
  });

  it('refuses a charge faster than the battery takes, even when a slower step follows', () => {
    const r = check('battery_power', ctx({ targets: [at(0, 20), at(1, 60), at(2, 59)] }));
    expect(r).toEqual({
      id: 'battery_power',
      ok: false,
      reason: 'The plan asks the battery to charge at 6.1 kW; it takes at most 5.0 kW.',
      measured: 6133,
      limit: profile.battery.maxChargeW,
      nearestAllowed: profile.battery.maxChargeW,
      unit: 'W',
    });
  });
});

describe('safe_room_comfort', () => {
  it('gives the plan its grace period, then checks every point from it (boundary included)', () => {
    expect(check('safe_room_comfort', ctx({ points: [point(0, { tempC: 30 }), point(59, { tempC: 30 }), point(60, { tempC: 26 })] })).ok).toBe(true);
    expect(check('safe_room_comfort', ctx({ points: [point(0, { tempC: 26 }), point(60, { tempC: 27.5 })] })).ok).toBe(false);
  });

  it('checks the last point when the projection is shorter than the grace', () => {
    expect(check('safe_room_comfort', ctx({ points: [point(0, { tempC: 26 }), point(30, { tempC: 28 })] })).ok).toBe(false);
  });

  it('holds at the cooling maximum and reports the range', () => {
    expect(check('safe_room_comfort', ctx({ points: [point(60, { tempC: 25.5, rh: 45 }), point(65, { tempC: 27, rh: 60 })] }))).toEqual({
      id: 'safe_room_comfort',
      ok: true,
      reason: 'The safe room stays between 25.5 and 27 °C, humidity 45-60 %.',
      measured: 27,
      limit: 27,
      unit: 'C',
    });
  });

  it('fails above the cooling maximum', () => {
    expect(check('safe_room_comfort', ctx({ points: [point(60, { tempC: 27.1 })] }))).toEqual({
      id: 'safe_room_comfort',
      ok: false,
      reason: 'The safe room would reach 27.1 °C, above its 27 °C maximum.',
      measured: 27.1,
      limit: 27,
      nearestAllowed: 27,
      unit: 'C',
    });
  });

  it('in the heating season checks the minimum, and reports it', () => {
    expect(check('safe_room_comfort', ctx({ season: 'heating', points: [point(60, { tempC: 18 }), point(65, { tempC: 30 })] }))).toMatchObject({ ok: true, measured: 18, limit: 18 });
    expect(check('safe_room_comfort', ctx({ season: 'heating', points: [point(60, { tempC: 17.9 })] }))).toMatchObject({
      ok: false,
      reason: 'The safe room would drop to 17.9 °C, below its 18 °C minimum.',
      measured: 17.9,
      limit: 18,
      unit: 'C',
    });
  });

  it('ignores the heating minimum in the cooling season, and checks both in neutral', () => {
    expect(check('safe_room_comfort', ctx({ points: [point(60, { tempC: 17 })] })).ok).toBe(true);
    expect(check('safe_room_comfort', ctx({ season: 'neutral', points: [point(60, { tempC: 17 })] })).ok).toBe(false);
    expect(check('safe_room_comfort', ctx({ season: 'neutral', points: [point(60, { tempC: 28 })] })).ok).toBe(false);
  });

  it('checks the measured humidity at both bounds', () => {
    expect(check('safe_room_comfort', ctx({ points: [point(60, { rh: 40 }), point(65, { rh: 60 })] })).ok).toBe(true);
    expect(check('safe_room_comfort', ctx({ points: [point(60, { rh: 60.6 })] }))).toEqual({
      id: 'safe_room_comfort',
      ok: false,
      reason: 'Humidity in the safe room would reach 61 %, above 60 %.',
      measured: 60.6,
      limit: 60,
      nearestAllowed: 60,
      unit: '%',
    });
    // Below the minimum is the plan's doing only when it dries the room (#107): see the next test.
    const drying = input({ season: 'cooling', preferences: PreferencesSchema.parse(examplePreferences()), plan: plan([step({ mode: 'dry' })]) });
    expect(check('safe_room_comfort', ctx({ input: drying, points: [point(60, { rh: 39.4 })] }))).toMatchObject({
      ok: false,
      reason: 'Humidity in the safe room would drop to 39 %, below 40 %.',
      limit: 40,
      unit: '%',
    });
  });

  it('a point is the state the previous step left: drying in the last dry step counts, even under a fan-only step', () => {
    // Paced: dry for an hour, then only the fan. The point at 60 min is what the dry hour left (39 %).
    const paced = input({
      season: 'cooling',
      preferences: PreferencesSchema.parse(examplePreferences()),
      plan: plan([step({ mode: 'dry' }), step({ atMs: T0 + H, mode: 'fan_only' })]),
    });
    expect(check('safe_room_comfort', ctx({ input: paced, points: [point(55, { rh: 45 }), point(60, { rh: 39 })] }))).toMatchObject({ ok: false, limit: 40 });
    // And air that a fan-only step left dry is the weather's doing.
    expect(check('safe_room_comfort', ctx({ input: paced, points: [point(60, { rh: 45 }), point(65, { rh: 39 })] })).ok).toBe(true);
    // The dry-air warning blames the weather only for the second case, never for what the dry hour left.
    expect(dryAirWarning(ctx({ input: paced, points: [point(55, { rh: 45 }), point(60, { rh: 39 })] }))).toBeUndefined();
    expect(dryAirWarning(ctx({ input: paced, points: [point(60, { rh: 45 }), point(65, { rh: 39 })] }))?.code).toBe('dry_air');
  });

  it('dry air: only after the grace period, only the safe room, strictly under the minimum, and the lowest value', () => {
    const warn = (points: ProjectionPoint[]) => dryAirWarning(ctx({ points }));
    expect(warn([point(55, { rh: 35 })])).toBeUndefined();
    expect(warn([point(60, { rh: 35 })])?.code).toBe('dry_air');
    expect(warn([point(60, { rh: 35, room: 'living' })])).toBeUndefined();
    expect(warn([point(60, { rh: 40 })])).toBeUndefined();
    expect(warn([point(60, { rh: 38 }), point(65, { rh: 35 })])?.message).toContain('down to 35 %, under 40 %');
  });

  it('dry air names the safe room the person chose', () => {
    const living = input({ season: 'cooling', preferences: PreferencesSchema.parse({ ...examplePreferences(), safeRoomId: 'living', roomPriority: ['living', 'bedroom-1', 'study'] }) });
    expect(dryAirWarning(ctx({ input: living, points: [point(60, { rh: 35, room: 'living' })] }))?.message).toMatch(/^The air in the Living room is dry/);
  });

  it('does not blame a plan that cools for air that is dry anyway: the plan cannot raise the humidity', () => {
    // Cooling, not drying: a room under the minimum is the weather's doing (a warning, not a refusal).
    expect(check('safe_room_comfort', ctx({ points: [point(60, { rh: 35 })] })).ok).toBe(true);
    const fanOnly = input({ season: 'cooling', preferences: PreferencesSchema.parse(examplePreferences()), plan: plan([step({ mode: 'fan_only' })]) });
    expect(check('safe_room_comfort', ctx({ input: fanOnly, points: [point(60, { rh: 35 })] })).ok).toBe(true);
  });

  it('fails safe when the safe room has no reading', () => {
    expect(check('safe_room_comfort', ctx({ points: [point(60, { room: 'living' })] }))).toEqual({
      id: 'safe_room_comfort',
      ok: false,
      reason: 'The safe room has no reading, so its safety cannot be checked.',
    });
  });
});

describe('pacing_on_track', () => {
  it('off grid, fails when load goes unserved before the recharge and says when', () => {
    const r = check('pacing_on_track', ctx({ gridAvailable: false, points: [point(0), point(8 * 60, { unservedW: 1.5 }), point(9 * 60, { unservedW: 300 })] }));
    expect(r).toEqual({
      id: 'pacing_on_track',
      ok: false,
      reason: 'At this pace the battery runs out at 04:00, 120 min before the next recharge at 06:00.',
      measured: 120,
      limit: 0,
      nearestAllowed: 0,
      unit: 'min',
    });
  });

  it('ignores rounding noise up to 1 W, and anything unserved on grid', () => {
    expect(check('pacing_on_track', ctx({ gridAvailable: false, points: [point(0, { unservedW: 1 })] })).ok).toBe(true);
    expect(check('pacing_on_track', ctx({ points: [point(0, { unservedW: 500 })] })).ok).toBe(true);
  });

  it('holds on the track within the tolerance (boundary) and says the energy lasts', () => {
    expect(check('pacing_on_track', ctx({ gridAvailable: false, targets: [at(0, 60)], points: [point(0, { soc: 57 })] }))).toEqual({
      id: 'pacing_on_track',
      ok: true,
      reason: 'The energy lasts until the next recharge at 06:00.',
    });
    expect(check('pacing_on_track', ctx({ targets: [at(0, 60)], points: [point(0, { soc: 57 })] })).reason).toBe('The battery follows the plan until the next recharge.');
  });

  it('fails below the track, at the worst point, with the highest target the projection can follow', () => {
    const r = check('pacing_on_track', ctx({ targets: [at(0, 60)], points: [point(0, { soc: 56.9 }), point(60, { soc: 50 }), point(120, { soc: 52 })] }));
    expect(r).toEqual({
      id: 'pacing_on_track',
      ok: false,
      reason: "At 21:00 the battery would be at 50 %, below the plan's 60 %.",
      measured: 50,
      limit: 57,
      nearestAllowed: 53,
      unit: '%',
    });
  });

  it('a target applies only from its own time', () => {
    expect(check('pacing_on_track', ctx({ targets: [at(1, 90)], points: [point(0, { soc: 50 })] })).ok).toBe(true);
  });
});
