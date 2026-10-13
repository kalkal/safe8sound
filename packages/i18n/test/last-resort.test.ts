import { LAST_RESORT_ACTIONS } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { emergencyNumberOf, lastResortAdvice } from '../src/index.js';

// The fixed list on the last-resort card (#160): zero-energy actions and the signs of heat illness,
// from public-health guidance (docs/heat-advice.md). Never presented as medical protection.

describe('last-resort advice', () => {
  it('has a line for every action the plan can list, in the order given', () => {
    const advice = lastResortAdvice('en-US', LAST_RESORT_ACTIONS, 'C', 'turin');
    expect(advice.actions).toHaveLength(LAST_RESORT_ACTIONS.length);
    expect(advice.actions[0]).toBe('Close the curtains on the sunny side.');
    expect(lastResortAdvice('en-US', ['drink_water'], 'C', 'turin').actions).toEqual(['Drink water often, even without thirst.']);
  });

  it('the fan line keeps the 35 °C rule', () => {
    expect(lastResortAdvice('en-US', ['fan_below_35c'], 'C', 'turin').actions[0]).toContain('35 °C');
  });

  it('the fan line in the unit the sandbox chose: 35 °C is 95 °F (#306)', () => {
    expect(lastResortAdvice('en-US', ['fan_below_35c'], 'F', 'houston').actions[0]).toBe('Use a fan only while the room is below 95 °F.');
    expect(lastResortAdvice('it-IT', ['fan_below_35c'], 'F', 'houston').actions[0]).toBe('Usa un ventilatore solo finché la stanza è sotto i 95 °F.');
  });

  it('always gives the heat-stroke signs and says to call 112 when worried', () => {
    const advice = lastResortAdvice('en-US', [], 'C', 'reference');
    expect(advice.signs.length).toBeGreaterThanOrEqual(4);
    expect(advice.signs).toContain('Confusion or lack of coordination');
    expect(advice.call).toBe('If you are worried, call 112.');
  });

  it('the number to call follows the place, not the language (#366): 911 in Houston, 112 in Turin and the reference home', () => {
    expect(emergencyNumberOf('houston')).toBe('911');
    expect(emergencyNumberOf('turin')).toBe('112');
    expect(emergencyNumberOf('reference')).toBe('112');
    expect(lastResortAdvice('en-US', [], 'F', 'houston').call).toBe('If you are worried, call 911.');
    expect(lastResortAdvice('it-IT', [], 'F', 'houston').call).toBe('Se sei preoccupato, chiama il 911.');
    expect(lastResortAdvice('en-US', [], 'C', 'turin').call).toBe('If you are worried, call 112.');
    expect(lastResortAdvice('it-IT', [], 'C', 'turin').call).toBe('Se sei preoccupato, chiama il 112.');
    expect(lastResortAdvice('it-IT', [], 'C', 'reference').call).toBe('Se sei preoccupato, chiama il 112.');
  });

  it('never claims to protect, prevent or treat', () => {
    const advice = lastResortAdvice('en-US', LAST_RESORT_ACTIONS, 'C', 'turin');
    for (const line of [advice.title, ...advice.actions, advice.signsTitle, ...advice.signs, advice.call, advice.notMedical]) {
      expect(line).not.toMatch(/\b(protect|prevent|treat|cure|guarantee)/i);
    }
    expect(advice.notMedical).toBe('These are general tips, not medical advice.');
  });
});
