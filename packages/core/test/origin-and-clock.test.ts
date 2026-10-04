import { DATA_GROUPS, DataOriginSchema, type DataGroup } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixedClock, scenarioClock, utcDayStart } from '../src/clock.js';
import { resolveOrigin } from '../src/origin.js';

const storm = { id: 'storm-blackout', simulatedGroups: DATA_GROUPS };
const heatwave = { id: 'heatwave', simulatedGroups: ['weather'] as const };

describe('resolveOrigin (per field group, plan §9.4)', () => {
  it('is fully live when every group is live and no scenario applies', () => {
    expect(resolveOrigin(DATA_GROUPS)).toEqual({ energy: 'live', rooms: 'live', weather: 'live' });
  });

  it('is fully simulated, without a scenario name, for a plain simulator', () => {
    expect(resolveOrigin([])).toEqual({ energy: 'simulated', rooms: 'simulated', weather: 'simulated' });
  });

  it('a heatwave over live data simulates the weather only', () => {
    expect(resolveOrigin(DATA_GROUPS, heatwave)).toEqual({ energy: 'live', rooms: 'live', weather: 'simulated', scenario: 'heatwave' });
  });

  it('a storm/blackout scenario always marks every group simulated', () => {
    fc.assert(
      fc.property(fc.subarray([...DATA_GROUPS]), (live: DataGroup[]) => {
        expect(resolveOrigin(live, storm)).toEqual({ energy: 'simulated', rooms: 'simulated', weather: 'simulated', scenario: 'storm-blackout' });
      }),
    );
  });

  it('always satisfies the contract schema', () => {
    fc.assert(
      fc.property(fc.subarray([...DATA_GROUPS]), fc.subarray([...DATA_GROUPS]), fc.boolean(), (live, simulated, withScenario) => {
        const origin = resolveOrigin(live, withScenario ? { id: 'clear-day', simulatedGroups: simulated } : undefined);
        expect(DataOriginSchema.safeParse(origin).success).toBe(true);
        for (const g of DATA_GROUPS) {
          expect(origin[g] === 'live').toBe(live.includes(g) && !(withScenario && simulated.includes(g)));
        }
      }),
    );
  });
});

describe('clocks', () => {
  it('a fixed clock always returns its instant', () => {
    const clock = fixedClock(1_000);
    expect([clock.now(), clock.now()]).toEqual([1_000, 1_000]);
  });

  it('a scenario clock maps wall time onto scenario time from an anchor, at a given speed', () => {
    let wall = 5_000;
    const clock = scenarioClock({ wall: { now: () => wall }, anchorMs: 5_000, scenarioStartMs: 1_000_000, speed: 60 });
    expect(clock.now()).toBe(1_000_000);
    wall += 1_000;
    expect(clock.now()).toBe(1_060_000);
  });

  it('says when its current playthrough began: the fixed anchor for ever, a daily anchor anew every day (#234)', () => {
    let wall = Date.parse('2026-10-01T05:00:00Z');
    const fixed = scenarioClock({ wall: { now: () => wall }, anchorMs: 5_000, scenarioStartMs: 0 });
    const daily = scenarioClock({ wall: { now: () => wall }, anchorMs: utcDayStart, scenarioStartMs: 0 });
    expect(fixed.playthrough?.()).toBe(5_000);
    expect(daily.playthrough?.()).toBe(Date.parse('2026-10-01T00:00:00Z'));
    wall = Date.parse('2026-10-02T05:00:00Z');
    expect(fixed.playthrough?.()).toBe(5_000);
    expect(daily.playthrough?.()).toBe(Date.parse('2026-10-02T00:00:00Z'));
    expect(fixedClock(1).playthrough).toBeUndefined();
  });

  it('runs in real time by default', () => {
    const clock = scenarioClock({ wall: fixedClock(7_000), anchorMs: 5_000, scenarioStartMs: 0 });
    expect(clock.now()).toBe(2_000);
  });

  it('anchors on the start of the UTC day: a pure function of wall time, so every container agrees', () => {
    const at = (iso: string) => scenarioClock({ wall: fixedClock(Date.parse(iso)), anchorMs: utcDayStart, scenarioStartMs: 1_000_000, speed: 2 }).now();
    expect(at('2026-10-01T00:00:00Z')).toBe(1_000_000);
    expect(at('2026-10-01T05:00:00Z')).toBe(1_000_000 + 10 * 3_600_000);
    // The next day replays the scenario from its start.
    expect(at('2026-10-02T05:00:00Z')).toBe(at('2026-10-01T05:00:00Z'));
  });

  it('utcDayStart drops the time of day, for any instant', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_102_444_800_000 }), (ms) => {
        const start = utcDayStart(ms);
        expect(new Date(start).toISOString()).toMatch(/T00:00:00\.000Z$/);
        expect(ms - start).toBeGreaterThanOrEqual(0);
        expect(ms - start).toBeLessThan(86_400_000);
      }),
    );
  });
});
