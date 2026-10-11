import { fixedClock } from '@cold-reserve/core';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { wireModules } from '../src/wiring.js';
import { homeId } from './helpers.js';

const NOW_MS = Date.UTC(2026, 6, 15, 12);

describe('wireModules', () => {
  it('fails loudly when a home is used before bind(app), never falling back to the wall clock or °C', () => {
    const wired = wireModules({ store: memoryStateStoreFactory({ backing: createMemoryBacking(), clock: { now: () => NOW_MS } }), clock: fixedClock(NOW_MS) });
    if (!wired.ok) throw new Error(wired.error.message);
    expect(() => wired.value.comfortPlan.storeFor(homeId('demo'))).toThrow('wireModules: a home was used before bind(app)');
    wired.value.bind({ homeClock: () => undefined, homeUnits: () => 'C' } as unknown as App);
    expect(() => wired.value.comfortPlan.storeFor(homeId('demo'))).not.toThrow();
  });
});
