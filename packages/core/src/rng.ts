/** Uniform numbers in [0, 1). Always seeded: core never calls Math.random(). */
export interface Rng {
  next(): number;
}

/** Mulberry32: a small, fast 32-bit generator, plenty for simulated noise (not for security). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    },
  };
}

/**
 * The draw for step `index` of the stream `seed`, without replaying the stream:
 * the value for a step never depends on which steps were computed before it.
 */
export function rngAt(seed: number, index: number): number {
  return seededRng((seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0).next();
}
