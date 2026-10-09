import { afterEach, describe, expect, it } from 'vitest';
import { UNITS_CONTEXT_KEY, getTempUnit, setTempUnit, unitOfContext } from '../src/temp-unit.js';
import { formatMeasure } from '../src/text.js';

// °F everywhere (owner decision, 9 Oct): the host tells each card the unit the person chose through its own
// hostContext key; °C when it says nothing (a real Alexa+ host never sends the key).

afterEach(() => {
  setTempUnit('C');
});

describe('the temperature unit of the cards', () => {
  it('reads °C or °F from the host context, nothing else', () => {
    expect(UNITS_CONTEXT_KEY).toBe('coldReserveUnits');
    expect(unitOfContext({ [UNITS_CONTEXT_KEY]: 'F' })).toBe('F');
    expect(unitOfContext({ [UNITS_CONTEXT_KEY]: 'C' })).toBe('C');
    expect(unitOfContext({ [UNITS_CONTEXT_KEY]: 'K' })).toBeUndefined();
    expect(unitOfContext({})).toBeUndefined();
    expect(unitOfContext(undefined)).toBeUndefined();
  });

  it('is °C until the host says otherwise', () => {
    expect(getTempUnit()).toBe('C');
    setTempUnit('F');
    expect(getTempUnit()).toBe('F');
  });

  it('a temperature measure on the receipt follows the unit; energy and percentages do not change', () => {
    expect(formatMeasure(26.8, 'C')).toBe('26.8 °C');
    setTempUnit('F');
    expect(formatMeasure(26.8, 'C')).toBe('80.2 °F');
    expect(formatMeasure(24, 'C')).toBe('75.2 °F');
    expect(formatMeasure(5400, 'W')).toBe('5.4 kW');
    expect(formatMeasure(43, '%')).toBe('43%');
  });
});
