import { describe, expect, it } from 'vitest';
import { orderSurplusRooms, surplusWindow } from '../src/surplus.js';

// Solar surplus at home instead of on the grid (#203): the window where the projection exports, and the order
// in which the rooms get it.

const H = 3_600_000;
const T0 = Date.parse('2026-07-16T14:00:00Z');
const STEP = 5 * 60_000;
const points = (exportW: (i: number) => number, n = 72, socPct: (i: number) => number = () => 100) =>
  Array.from({ length: n }, (_, i) => ({ ms: T0 + i * STEP, socPct: socPct(i), flows: { gridExportW: exportW(i) } }));

describe('surplusWindow', () => {
  it('the first run of steps exporting at least the minimum, its mean export and the energy it sends out', () => {
    const w = surplusWindow(points((i) => (i >= 12 && i < 36 ? 2_000 : 100)), { minExportW: 300, stepMs: STEP });
    expect(w).toEqual({ fromMs: T0 + 1 * H, toMs: T0 + 3 * H, meanExportW: 2_000, exportWh: 4_000 });
  });

  it('a step under the minimum ends the run: a short dip is a new window, the first one counts', () => {
    const w = surplusWindow(points((i) => (i >= 12 && i < 36 && i !== 24 ? 1_000 : 0)), { minExportW: 300, stepMs: STEP });
    expect(w?.toMs).toBe(T0 + 2 * H);
  });

  it('no export, or export under the minimum everywhere: no window', () => {
    expect(surplusWindow(points(() => 0), { minExportW: 300, stepMs: STEP })).toBeUndefined();
    expect(surplusWindow(points(() => 299), { minExportW: 300, stepMs: STEP })).toBeUndefined();
  });

  it('only with the battery full or nearly: export caused by the charge limit at 60 % is no surplus (#226 review)', () => {
    expect(surplusWindow(points(() => 2_000, 72, () => 60), { minExportW: 300, stepMs: STEP, minSocPct: 95 })).toBeUndefined();
    // Every step of the window must be at or above the level: the window ends where the battery drops below it.
    const w = surplusWindow(points(() => 2_000, 72, (i) => (i < 24 ? 96 : 90)), { minExportW: 300, stepMs: STEP, minSocPct: 95 });
    expect(w).toMatchObject({ fromMs: T0, toMs: T0 + 2 * H });
  });

  it('a run up to the end of the projection ends one step after its last point', () => {
    expect(surplusWindow(points(() => 500, 12), { minExportW: 300, stepMs: STEP })).toMatchObject({ fromMs: T0, toMs: T0 + H });
  });
});

describe('orderSurplusRooms', () => {
  const room = (id: string, tempC: number, occupied: boolean, over: { isSafe?: boolean; sleptIn?: boolean } = {}) => ({ id, tempC, occupied, isSafe: false, sleptIn: false, ...over });

  it('a room with no reading gets no surplus: how far above comfort it is would be made up (review of #303)', () => {
    const order = orderSurplusRooms(
      [room('bedroom-1', 26, true, { isSafe: true }), { id: 'bedroom-2', tempC: undefined, occupied: false, isSafe: false, sleptIn: true }],
      { comfortC: 25, tonight: true },
    );
    expect(order.map((r) => r.roomId)).toEqual(['bedroom-1']);
  });

  it('the safe room first, then the rooms that are or will be occupied, the hottest above target first', () => {
    const order = orderSurplusRooms(
      [room('study', 27, true), room('bedroom-2', 31.9, false, { sleptIn: true }), room('bedroom-1', 26, true, { isSafe: true, sleptIn: true }), room('living', 30, false)],
      { comfortC: 25, tonight: true },
    );
    expect(order).toEqual([
      { roomId: 'bedroom-1', reason: 'safe_room', aboveTargetK: 1 },
      { roomId: 'bedroom-2', reason: 'occupied_tonight', aboveTargetK: 6.9 },
      { roomId: 'study', reason: 'occupied', aboveTargetK: 2 },
    ]);
  });

  it('a slept-in room counts as occupied tonight only when the window comes before the night', () => {
    const order = orderSurplusRooms([room('bedroom-1', 26, true, { isSafe: true }), room('bedroom-2', 31.9, false, { sleptIn: true })], { comfortC: 25, tonight: false });
    expect(order.map((r) => r.roomId)).toEqual(['bedroom-1']);
  });

  it('a room occupied now and slept in is "occupied"; the safe room is always in, even at or below target', () => {
    const order = orderSurplusRooms([room('bedroom-1', 24, false, { isSafe: true }), room('bedroom-2', 28, true, { sleptIn: true })], { comfortC: 25, tonight: true });
    expect(order).toEqual([
      { roomId: 'bedroom-1', reason: 'safe_room', aboveTargetK: -1 },
      { roomId: 'bedroom-2', reason: 'occupied', aboveTargetK: 3 },
    ]);
  });

  it('on a tie above target, the order of the input (the person’s room priority)', () => {
    const order = orderSurplusRooms([room('a', 27, true), room('b', 27, true)], { comfortC: 25, tonight: true });
    expect(order.map((r) => r.roomId)).toEqual(['a', 'b']);
  });
});
