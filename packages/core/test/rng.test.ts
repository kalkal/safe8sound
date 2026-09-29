import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { rngAt, seededRng } from '../src/rng.js';

const draws = (seed: number, n: number): number[] => {
  const rng = seededRng(seed);
  return Array.from({ length: n }, () => rng.next());
};

describe('seededRng', () => {
  it('gives the same sequence for the same seed', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        expect(draws(seed, 20)).toEqual(draws(seed, 20));
      }),
    );
  });

  it('draws uniform numbers in [0, 1)', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        for (const x of draws(seed, 50)) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThan(1);
        }
      }),
    );
  });

  it('gives different sequences for different seeds', () => {
    expect(draws(1, 5)).not.toEqual(draws(2, 5));
  });
});

describe('rngAt', () => {
  it('is a pure function of seed and index', () => {
    fc.assert(
      fc.property(fc.integer(), fc.nat(1_000_000), (seed, index) => {
        const x = rngAt(seed, index);
        expect(rngAt(seed, index)).toBe(x);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(1);
      }),
    );
  });

  it('varies with the index', () => {
    const values = new Set(Array.from({ length: 100 }, (_, i) => rngAt(42, i)));
    expect(values.size).toBe(100);
  });
});
