import { LEVELS, levelRank, type Level, type PacingState } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { nextLevel, type LevelInput, type PacingConfig } from '../src/level.js';

// Mutation testing runs the properties with fewer cases (FC_RUNS); CI and local runs use the full count.
const runs = (n: number): number => Number(process.env['FC_RUNS'] ?? n);

const cfg: PacingConfig = { downMarginPct: 3, upMarginPct: 5, maxChangesPerHour: 4, minDwellMinutes: 20 };
const T0 = Date.UTC(2026, 6, 17, 13);
const MIN = 60_000;
const at = (ms: number) => new Date(ms).toISOString();
const state = (level: Level, changedMs = T0 - 60 * MIN): PacingState => ({ level, levelReason: 'user_choice', levelChangedAt: at(changedMs) });

const input = (over: Partial<LevelInput> = {}): LevelInput => ({
  current: state('comfort'),
  ladder: LEVELS,
  socPct: 60,
  trackSocPct: 60,
  nowMs: T0,
  recentChangesMs: [],
  ...over,
});

describe('nextLevel (plan §4bis.4-5)', () => {
  it('stays put while the SOC is on track', () => {
    const current = state('balanced');
    expect(nextLevel(input({ current }), cfg)).toBe(current);
  });

  it('steps down one level when the SOC falls below the track by more than the margin, and says why', () => {
    const next = nextLevel(input({ socPct: 56.9 }), cfg);
    expect(next).toEqual({ level: 'balanced', levelReason: 'soc_below_track', levelChangedAt: at(T0) });
  });

  it('does not step down inside the margin (boundary)', () => {
    expect(nextLevel(input({ socPct: 57 }), cfg).level).toBe('comfort');
  });

  it('never goes below the last rung of the confirmed ladder', () => {
    const current = state('saver');
    expect(nextLevel(input({ current, ladder: ['comfort', 'balanced', 'saver'], socPct: 10 }), cfg)).toBe(current);
  });

  it('steps back up only above the track by the up margin and after the dwell time', () => {
    const current = state('saver', T0 - 20 * MIN);
    expect(nextLevel(input({ current, socPct: 65 }), cfg).level).toBe('saver');
    expect(nextLevel(input({ current, socPct: 65.1 }), cfg)).toEqual({ level: 'balanced', levelReason: 'soc_above_track', levelChangedAt: at(T0) });
    expect(nextLevel(input({ current: state('saver', T0 - 19 * MIN), socPct: 70 }), cfg).level).toBe('saver');
  });

  it('back at the top of the ladder, the reason is the person\'s confirmed choice', () => {
    const next = nextLevel(input({ current: state('balanced'), socPct: 70 }), cfg);
    expect(next).toEqual({ level: 'comfort', levelReason: 'user_choice', levelChangedAt: at(T0) });
  });

  it('never climbs above the top of the confirmed ladder', () => {
    const current = state('balanced');
    expect(nextLevel(input({ current, ladder: ['balanced', 'saver', 'essential'], socPct: 90 }), cfg)).toBe(current);
  });

  it('allows at most N changes in the last hour', () => {
    const recent = [T0 - 50 * MIN, T0 - 40 * MIN, T0 - 30 * MIN, T0 - 20 * MIN];
    expect(nextLevel(input({ socPct: 10, recentChangesMs: recent }), cfg).level).toBe('comfort');
    expect(nextLevel(input({ socPct: 10, recentChangesMs: [T0 - 61 * MIN, ...recent.slice(1)] }), cfg).level).toBe('balanced');
  });

  it('counts only the changes of the last hour: not one exactly an hour ago, not future ones', () => {
    const hourAgo = Array.from({ length: 4 }, () => T0 - 60 * MIN);
    expect(nextLevel(input({ socPct: 10, recentChangesMs: hourAgo }), cfg).level).toBe('balanced');
    const future = Array.from({ length: 4 }, () => T0 + MIN);
    expect(nextLevel(input({ socPct: 10, recentChangesMs: future }), cfg).level).toBe('balanced');
    const now = Array.from({ length: 4 }, () => T0);
    expect(nextLevel(input({ socPct: 10, recentChangesMs: now }), cfg).level).toBe('comfort');
  });

  it('keeps a level that is not in the ladder as it is', () => {
    const current = state('essential');
    expect(nextLevel(input({ current, ladder: ['comfort', 'balanced'], socPct: 10 }), cfg)).toBe(current);
  });

  const level = fc.constantFrom(...LEVELS);
  const soc = fc.oneof(fc.constantFrom(57, 56.999, 65, 65.001), fc.double({ min: 0, max: 100, noNaN: true }));

  it('property: a lower SOC never gives a higher level', () => {
    fc.assert(
      fc.property(level, soc, soc, fc.integer({ min: 0, max: 120 }), (lv, a, b, dwell) => {
        const current = state(lv, T0 - dwell * MIN);
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const atLo = nextLevel(input({ current, socPct: lo }), cfg);
        const atHi = nextLevel(input({ current, socPct: hi }), cfg);
        expect(levelRank(atLo.level)).toBeGreaterThanOrEqual(levelRank(atHi.level));
      }),
      { numRuns: runs(10_000) },
    );
  });

  it('property: moves at most one rung, and at most N changes in any hour of a run', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 1, max: 15 }), soc), { minLength: 1, maxLength: 60 }), (ticks) => {
        let now = T0;
        let current = state('comfort', T0 - 120 * MIN);
        const changes: number[] = [];
        for (const [gapMin, s] of ticks) {
          now += gapMin * MIN;
          const next = nextLevel(input({ current, nowMs: now, socPct: s, recentChangesMs: changes }), cfg);
          expect(Math.abs(levelRank(next.level) - levelRank(current.level))).toBeLessThanOrEqual(1);
          if (next !== current) changes.push(now);
          current = next;
        }
        for (const t of changes) {
          expect(changes.filter((c) => c > t - 60 * MIN && c <= t).length).toBeLessThanOrEqual(cfg.maxChangesPerHour);
        }
      }),
      { numRuns: runs(10_000) },
    );
  });
});
