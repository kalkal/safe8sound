import { HomeProfileSchema, celsius, pct, watt, type HomeProfile } from '@cold-reserve/contracts';
import type { ProjectionPoint } from '@cold-reserve/core';
import { describe, expect, it } from 'vitest';
import { projectFrom } from '../src/context.js';
import { nightMeets, referenceControl, referenceDries, referenceProves } from '../src/night.js';
import { H, MIN, T0, input, profile } from './support.js';

// The pieces of the night-recovery check, on their own: when a night counts as met, when the reference
// strategy proves a target reachable, and what that reference runs.

describe('nightMeets', () => {
  const at = (achievedHours: number, heatIndexDegreeHours: number) => ({ achievedHours, heatIndexDegreeHours });

  it('is met at exactly the required hours and exactly the heat budget', () => {
    expect(nightMeets(at(6, 4), 6, 4)).toBe(true);
  });

  it('forgives only rounding noise on either side', () => {
    expect(nightMeets(at(6 - 1e-10, 4 + 1e-10), 6, 4)).toBe(true);
    expect(nightMeets(at(5.99, 4), 6, 4)).toBe(false);
    expect(nightMeets(at(6, 4.01), 6, 4)).toBe(false);
  });

  it('is not met without metrics', () => {
    expect(nightMeets(undefined, 0, 4)).toBe(false);
  });
});

describe('referenceProves', () => {
  // 20:00 to 08:00 in 5-minute points; the night window is 22:00 to 07:00.
  const start = T0 + 2 * H;
  const end = T0 + 11 * H;
  const band = { minPct: 40, maxPct: 60 };
  const base = projectFrom(input(), () => [], { toMs: T0 + 12 * H, dischargeFloorPct: pct(10) });
  const shaped = (rh: (ms: number, roomId: string) => number, unservedAt?: { ms: number; w: number }): ProjectionPoint[] =>
    base.map((p) => ({
      ...p,
      rooms: p.rooms.map((r) => ({ ...r, humidityPct: pct(rh(p.ms, r.id)) })),
      flows: { ...p.flows, unservedLoadW: watt(unservedAt?.ms === p.ms ? unservedAt.w : 0) },
    }));
  const proves = (points: ProjectionPoint[], gridAvailable = true, dries = true) => referenceProves(points, { gridAvailable, window: { startMs: start, endMs: end }, roomId: 'bedroom-1', band, dries });
  const inBand = () => 50;
  /** Out of the band in `roomId` at exactly `ms`, in the band everywhere else. */
  const spike = (ms: number, roomId = 'bedroom-1', value = 75) => (t: number, id: string) => (t === ms && id === roomId ? value : 50);

  it('proves a target when the safe room stays in its humidity band through the window', () => {
    expect(proves(shaped(inBand))).toBe(true);
  });

  it('accepts the edges of the band', () => {
    expect(proves(shaped((t) => (t < start + H ? 40 : 60)))).toBe(true);
  });

  it('proves nothing if the safe room leaves the band inside the window, from its first point to its last', () => {
    expect(proves(shaped(spike(start)))).toBe(false);
    expect(proves(shaped(spike(end - 5 * MIN)))).toBe(false);
    expect(proves(shaped(spike(start + 3 * H, 'bedroom-1', 35)))).toBe(false);
  });

  it('a reference that cools, not dries, is not blamed for air drier than the band (#107)', () => {
    expect(proves(shaped(spike(start + 3 * H, 'bedroom-1', 35)), true, false)).toBe(true);
    expect(proves(shaped(spike(start + 3 * H, 'bedroom-1', 75)), true, false)).toBe(false);
  });

  it('ignores the hours outside the window and the other rooms', () => {
    expect(proves(shaped(spike(start - 5 * MIN)))).toBe(true);
    expect(proves(shaped(spike(end)))).toBe(true);
    expect(proves(shaped(spike(start + H, 'living')))).toBe(true);
  });

  it('off grid, proves nothing if the reference leaves load unserved (the battery ran out)', () => {
    expect(proves(shaped(inBand, { ms: start + 4 * H, w: 2 }), false)).toBe(false);
    // Rounding noise of the dispatch is not a shortfall.
    expect(proves(shaped(inBand, { ms: start + 4 * H, w: 1 }), false)).toBe(true);
    // With the grid up the battery cannot run out.
    expect(proves(shaped(inBand, { ms: start + 4 * H, w: 2 }), true)).toBe(true);
  });
});

describe('referenceControl', () => {
  const start = T0 + 2 * H;
  const withModes = (modes: ('cool' | 'dry' | 'fan_only')[]): HomeProfile =>
    HomeProfileSchema.parse({
      ...profile,
      rooms: profile.rooms.map((r) => (r.id === 'bedroom-1' ? { ...r, hvacUnits: r.hvacUnits.map((u) => ({ ...u, modes })) } : r)),
    });

  it('keeps every room off, fans included, until the window', () => {
    const control = referenceControl(profile, 'bedroom-1', start, 23.5);
    expect(control(start - 5 * MIN)).toEqual([
      { id: 'bedroom-1', fanOn: false },
      { id: 'living', fanOn: false },
      { id: 'study', fanOn: false },
    ]);
  });

  it('from the window on, cools only the safe room below the threshold, without the fan', () => {
    const control = referenceControl(profile, 'bedroom-1', start, 23.5);
    expect(control(start)).toEqual([
      { id: 'bedroom-1', hvac: { mode: 'cool', setpointC: celsius(23.5) }, fanOn: false },
      { id: 'living', fanOn: false },
      { id: 'study', fanOn: false },
    ]);
  });

  it('dries when the safe room unit cannot cool, and does nothing when it can do neither', () => {
    expect(referenceControl(withModes(['dry', 'fan_only']), 'bedroom-1', start, 23.5)(start)[0]).toEqual({
      id: 'bedroom-1',
      hvac: { mode: 'dry', setpointC: celsius(23.5) },
      fanOn: false,
    });
    expect(referenceControl(withModes(['fan_only']), 'bedroom-1', start, 23.5)(start)[0]).toEqual({ id: 'bedroom-1', fanOn: false });
  });

  it('dries only when the safe room unit cannot cool', () => {
    expect(referenceDries(profile, 'bedroom-1')).toBe(false);
    expect(referenceDries(withModes(['dry', 'fan_only']), 'bedroom-1')).toBe(true);
    expect(referenceDries(withModes(['fan_only']), 'bedroom-1')).toBe(false);
  });

  it('runs nothing when the safe room is not in the home', () => {
    expect(referenceControl(profile, 'attic', start, 23.5)(start).every((c) => c.hvac === undefined)).toBe(true);
  });
});
