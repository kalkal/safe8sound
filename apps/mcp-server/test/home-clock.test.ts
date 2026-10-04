import { HomeIdSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { atHome, type ComfortHome } from '../src/modules/comfort-plan/deps.js';

// C2a (Refs #222): a tool call on a home runs on that home's scenario clock when the composition root gives it
// one, so a sandbox playing another scenario plans on its own time. Without one, the module's clock as before.

const A = HomeIdSchema.parse('demo#00000000000000aa');
const B = HomeIdSchema.parse('demo#00000000000000bb');
const home = (clock?: { now: () => number }) => ({ ...(clock === undefined ? {} : { clock }) }) as unknown as ComfortHome;

describe('atHome', () => {
  const moduleClock = { now: () => 1 };
  const homeClock = { now: () => 2 };
  const deps = { clock: moduleClock, homes: (id: typeof A) => (id === A ? home(homeClock) : id === B ? home() : undefined), other: 'kept' };

  it('gives the call the home own clock and keeps every other dependency', () => {
    const scoped = atHome(deps, A);
    expect(scoped.clock.now()).toBe(2);
    expect(scoped.other).toBe('kept');
  });

  it('keeps the module clock for a home without one, and for an unknown home', () => {
    expect(atHome(deps, B)).toBe(deps);
    expect(atHome(deps, HomeIdSchema.parse('home'))).toBe(deps);
  });
});
