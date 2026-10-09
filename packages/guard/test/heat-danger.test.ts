import { describe, expect, it } from 'vitest';
import { ELDERLY_CRITICAL_C, EXTREME_CAUTION_HEAT_INDEX_C, heatDanger, heatDangerReason, roundedHeatIndexC } from '../src/heat-danger.js';

// #248: heat danger in the safe room is the air temperature or the NWS heat index above the limit in force; humid air
// alone is not. Two fixed caps hold whatever the limit: the NWS Extreme Caution band (heat index from 32.2 °C) for
// everyone, and Health Canada's 31 °C for an older person. They are health thresholds, never settings.

const at = (tempC: number, humidityPct: number) => ({ tempC, humidityPct });

describe('roundedHeatIndexC', () => {
  it('rounds the heat index to 0.5 °C, so 24 °C at 69 % (24.1 °C) reads 24 °C', () => {
    expect(roundedHeatIndexC(at(24, 69))).toBe(24);
    expect(roundedHeatIndexC(at(26, 90))).toBe(26.5);
  });
});

describe('heatDanger', () => {
  it('24 °C at 69 % with a 24 °C limit and an older person: no danger (humid air is a warning, not a refusal)', () => {
    expect(heatDanger(at(24, 69), { limitC: 24, elderly: true })).toBeUndefined();
  });

  it('26 °C at 90 % with a 26 °C limit and an older person: refused, it feels like 26.5 °C', () => {
    expect(heatDanger(at(26, 90), { limitC: 26, elderly: true })).toEqual({ rule: 'heat_index', valueC: 26.5, limitC: 26 });
  });

  it('the same room passes under a 27 °C limit', () => {
    expect(heatDanger(at(26, 90), { limitC: 27, elderly: false })).toBeUndefined();
  });

  it('the air above the limit comes first, as before', () => {
    expect(heatDanger(at(27.1, 40), { limitC: 27, elderly: false })).toEqual({ rule: 'temperature', valueC: 27.1, limitC: 27 });
  });

  it('the heat index at the limit passes, above it refuses even with the air at the limit', () => {
    expect(heatDanger(at(26, 90), { limitC: 26.5, elderly: false })).toBeUndefined();
    // 26.5 °C at 80 %: the averaged simple formula is over 80 °F, so the regression applies (about 28.7 °C).
    expect(heatDanger(at(26.5, 80), { limitC: 26.5, elderly: false })).toEqual({ rule: 'heat_index', valueC: 28.5, limitC: 26.5 });
  });

  it(`refuses from a heat index of ${String(EXTREME_CAUTION_HEAT_INDEX_C)} °C whatever the limit (NWS Extreme Caution)`, () => {
    // 30 °C at 60 % feels like about 32.8 °C.
    expect(heatDanger(at(30, 60), { limitC: 40, elderly: false })).toMatchObject({ rule: 'extreme_caution', limitC: EXTREME_CAUTION_HEAT_INDEX_C });
    expect(heatDanger(at(30, 40), { limitC: 40, elderly: false })).toBeUndefined();
  });

  it(`refuses above ${String(ELDERLY_CRITICAL_C)} °C of air with an older person whatever the limit (Health Canada), not without`, () => {
    expect(heatDanger(at(31.1, 20), { limitC: 40, elderly: true })).toEqual({ rule: 'elderly_critical', valueC: 31.1, limitC: ELDERLY_CRITICAL_C });
    expect(heatDanger(at(31, 20), { limitC: 40, elderly: true })).toBeUndefined();
    expect(heatDanger(at(31.1, 20), { limitC: 40, elderly: false })).toBeUndefined();
  });

  it('the caps are the NWS and Health Canada numbers', () => {
    expect(EXTREME_CAUTION_HEAT_INDEX_C).toBe(32.2);
    expect(ELDERLY_CRITICAL_C).toBe(31);
  });
});

describe('stricter caps from the settings (#266)', () => {
  it('a heat-index cap set lower refuses earlier, and says it is the set cap', () => {
    // 29 °C at 50 % feels like about 29.9 °C: under a 30 °C maximum, over a 29 °C cap.
    const caps = { heatIndexC: 29, elderlyC: 31 };
    const d = heatDanger(at(29, 50), { limitC: 30, elderly: false, caps });
    expect(d).toMatchObject({ rule: 'extreme_caution', limitC: 29 });
    expect(heatDangerReason(at(29, 50), d ?? { rule: 'temperature', valueC: 0, limitC: 0 })).toMatch(/above the 29 °C heat-index cap set for this home\.$/);
    expect(heatDanger(at(29, 50), { limitC: 30, elderly: false })).toBeUndefined();
  });

  it('an older-person cap set lower refuses earlier, and says so', () => {
    const d = heatDanger(at(28.5, 20), { limitC: 30, elderly: true, caps: { heatIndexC: 32.2, elderlyC: 28 } });
    expect(d).toEqual({ rule: 'elderly_critical', valueC: 28.5, limitC: 28 });
    expect(heatDangerReason(at(28.5, 20), d ?? { rule: 'temperature', valueC: 0, limitC: 0 })).toBe('The safe room would reach 28.5 °C, above the 28 °C set for an older person.');
  });

  it('the default caps keep the health wording', () => {
    const d = heatDanger(at(30, 60), { limitC: 40, elderly: false });
    expect(heatDangerReason(at(30, 60), d ?? { rule: 'temperature', valueC: 0, limitC: 0 })).toMatch(/Extreme Caution band from 32\.2 °C\.$/);
  });
});
