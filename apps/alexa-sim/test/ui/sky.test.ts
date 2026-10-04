import { hotDayPlan, homeInStorm, lastResortPlan, safeRoomCalm, safeRoomInStorm, stormPlan } from '@cold-reserve/ui-cards';
import { describe, expect, it } from 'vitest';
import type { ToolCard } from '../../src/agent/wire.js';
import { skyFor } from '../../src/ui/sky.js';

// The sky in the Echo Show frame follows the scenario weather (plan §11.1, analysis G2): sun on a mild day,
// heat haze on a hot one, the warm dusk of a heatwave evening, storm clouds while the grid is down.

const TZ = 'Europe/Rome';
const plan = (result: ToolCard['result']) => ({ tool: 'plan_comfort', result }) as ToolCard;

describe('skyFor', () => {
  it('a hot-day plan made in the afternoon: heat haze', () => {
    expect(skyFor([plan(hotDayPlan())], TZ, 'mild')).toBe('hot');
  });

  it('the same heatwave in the evening, on the home clock: dusk', () => {
    expect(skyFor([plan({ ...hotDayPlan(), createdAt: '2026-07-15T21:10:00+02:00' })], TZ, 'mild')).toBe('dusk');
    // 19:30 UTC is 21:30 in Rome: the home's clock decides, not the server's.
    expect(skyFor([plan({ ...hotDayPlan(), createdAt: '2026-07-15T19:30:00Z' })], TZ, 'mild')).toBe('dusk');
  });

  it('the grid down, in any card of the answer: storm clouds, whatever else the answer shows', () => {
    expect(skyFor([{ tool: 'get_safe_room_status', result: safeRoomInStorm() }, plan(hotDayPlan())], TZ, 'hot')).toBe('storm');
    expect(skyFor([plan(stormPlan())], TZ, 'hot')).toBe('storm');
    expect(skyFor([{ tool: 'get_home_status', result: homeInStorm() }], TZ, 'mild')).toBe('storm');
  });

  it('the storm over: the sun again', () => {
    expect(skyFor([{ tool: 'get_safe_room_status', result: { ...safeRoomCalm(), stormPhase: 'ended' } }], TZ, 'storm')).toBe('mild');
  });

  it('an answer that says nothing about the weather keeps the sky it had', () => {
    expect(skyFor([], TZ, 'storm')).toBe('storm');
  });

  it('an applied plan carries its weather too', () => {
    expect(skyFor([{ tool: 'apply_plan', result: { plan: lastResortPlan(), alreadyApplied: false, advisoryOnly: false, manualInstructions: [] } }], TZ, 'dusk')).toBe('hot');
  });

  it('a plan that is not on a heatwave scenario leaves the sky as it was', () => {
    const mild = { ...hotDayPlan(), sourceOrigin: { energy: 'simulated' as const, rooms: 'simulated' as const, weather: 'simulated' as const } };
    expect(skyFor([plan(mild)], TZ, 'storm')).toBe('storm');
  });
});
