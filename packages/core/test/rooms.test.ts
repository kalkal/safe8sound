import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocateRooms } from '../src/index.js';

// Mutation testing runs the properties with fewer cases (FC_RUNS); CI and local runs use the full count.
const runs = (n: number): number => Number(process.env['FC_RUNS'] ?? n);

describe('allocateRooms: room priority under the inverter limit (plan §4ter, §11.6)', () => {
  const demands = [
    { roomId: 'living', demandW: 2300 },
    { roomId: 'bedroom-1', demandW: 1600 },
    { roomId: 'study', demandW: 1500 },
  ];
  const priority = ['bedroom-1', 'living', 'study'];

  it('serves rooms in priority order while they fit, the safe room first', () => {
    expect(allocateRooms({ demands, priority, budgetW: 4000 })).toEqual([
      { roomId: 'bedroom-1', state: 'served' },
      { roomId: 'living', state: 'served' },
      { roomId: 'study', state: 'waiting', waitingReason: 'inverter_limit' },
    ]);
  });

  it('lets a later, smaller room use what a larger one leaves', () => {
    expect(allocateRooms({ demands, priority, budgetW: 3200 }).map((r) => r.state)).toEqual(['served', 'waiting', 'served']);
  });

  it('serves a room whose demand is exactly the budget left (boundary)', () => {
    expect(allocateRooms({ demands, priority, budgetW: 3900 }).map((r) => r.state)).toEqual(['served', 'served', 'waiting']);
  });

  it('puts rooms missing from the priority list last, in their given order', () => {
    expect(allocateRooms({ demands, priority: ['bedroom-1'], budgetW: 10_000 }).map((r) => r.roomId)).toEqual(['bedroom-1', 'living', 'study']);
  });

  it('property: served rooms fit the budget, and no waiting room would have fitted when its turn came', () => {
    const room = fc.record({ roomId: fc.constantFrom('a', 'b', 'c', 'd', 'e'), demandW: fc.integer({ min: 0, max: 3000 }) });
    fc.assert(
      fc.property(fc.uniqueArray(room, { selector: (r) => r.roomId, maxLength: 5 }), fc.integer({ min: 0, max: 8000 }), (ds, budgetW) => {
        const out = allocateRooms({ demands: ds, priority: ['c', 'a'], budgetW });
        let left = budgetW;
        for (const r of out) {
          const d = ds.find((x) => x.roomId === r.roomId)?.demandW ?? 0;
          if (r.state === 'served') {
            expect(d).toBeLessThanOrEqual(left);
            left -= d;
          } else {
            expect(d).toBeGreaterThan(left);
          }
        }
      }),
      { numRuns: runs(10_000) },
    );
  });
});
