import { DATA_GROUPS, DataOriginSchema, type DataGroup } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixedClock, scenarioClock } from '../src/clock.js';
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

  it('runs in real time by default', () => {
    const clock = scenarioClock({ wall: fixedClock(7_000), anchorMs: 5_000, scenarioStartMs: 0 });
    expect(clock.now()).toBe(2_000);
  });
});
