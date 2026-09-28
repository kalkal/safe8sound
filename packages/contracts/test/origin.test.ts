import { describe, expect, it } from 'vitest';
import { DataOriginSchema, isFullyLive } from '../src/index.js';

describe('DataOrigin (per field group, plan §9.4)', () => {
  const live = { energy: 'live', rooms: 'live', weather: 'live' } as const;

  it('declares live or simulated for energy, rooms and weather', () => {
    expect(DataOriginSchema.safeParse(live).success).toBe(true);
    expect(DataOriginSchema.safeParse({ ...live, weather: 'real' }).success).toBe(false);
    expect(DataOriginSchema.safeParse({ energy: 'live', rooms: 'live' }).success).toBe(false);
  });

  it('names the scenario only when at least one group is simulated', () => {
    expect(DataOriginSchema.safeParse({ ...live, weather: 'simulated', scenario: 'storm-blackout' }).success).toBe(true);
    expect(DataOriginSchema.safeParse({ ...live, scenario: 'storm-blackout' }).success).toBe(false);
  });

  it('is fully live only when every group is live', () => {
    expect(isFullyLive(DataOriginSchema.parse(live))).toBe(true);
    expect(isFullyLive(DataOriginSchema.parse({ ...live, weather: 'simulated', scenario: 'heatwave' }))).toBe(false);
  });

  it('can check only the groups a plan depends on', () => {
    const origin = DataOriginSchema.parse({ ...live, weather: 'simulated', scenario: 'heatwave' });
    expect(isFullyLive(origin, ['energy', 'rooms'])).toBe(true);
    expect(isFullyLive(origin, ['energy', 'weather'])).toBe(false);
  });
});
