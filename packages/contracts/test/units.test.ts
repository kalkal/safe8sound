import { describe, expect, it } from 'vitest';
import {
  TempUnitSchema,
  formatTemp,
  formatTempFixed,
  formatTempForInput,
  tempGap,
  toDisplayTemp,
  type TempUnit,
  CelsiusSchema,
  KilowattSchema,
  MinutesSchema,
  PctSchema,
  WattHourSchema,
  WattSchema,
  celsius,
  kilowatt,
  kilowattToWatt,
  minutes,
  pct,
  watt,
  wattHour,
  type Watt,
  type WattHour,
} from '../src/index.js';

describe('branded units', () => {
  it('accepts finite values and keeps the number', () => {
    expect(watt(-2500)).toBe(-2500);
    expect(wattHour(13_800)).toBe(13_800);
    expect(pct(10)).toBe(10);
    expect(celsius(26.5)).toBe(26.5);
    expect(minutes(90)).toBe(90);
    expect(kilowatt(3.2)).toBe(3.2);
  });

  it('rejects NaN and infinities for every unit', () => {
    for (const schema of [WattSchema, WattHourSchema, PctSchema, CelsiusSchema, MinutesSchema, KilowattSchema]) {
      expect(schema.safeParse(Number.NaN).success).toBe(false);
      expect(schema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    }
  });

  it('keeps percentages on the 0-100 scale, never 0-1 fractions above 100', () => {
    expect(PctSchema.safeParse(0).success).toBe(true);
    expect(PctSchema.safeParse(100).success).toBe(true);
    expect(PctSchema.safeParse(-0.1).success).toBe(false);
    expect(PctSchema.safeParse(100.1).success).toBe(false);
  });

  it('rejects negative energy and durations', () => {
    expect(WattHourSchema.safeParse(-1).success).toBe(false);
    expect(MinutesSchema.safeParse(-1).success).toBe(false);
    expect(KilowattSchema.safeParse(-0.5).success).toBe(false);
  });

  it('rejects physically absurd air temperatures', () => {
    expect(CelsiusSchema.safeParse(-61).success).toBe(false);
    expect(CelsiusSchema.safeParse(81).success).toBe(false);
  });

  it('converts kilowatts to watts explicitly', () => {
    const w: Watt = kilowattToWatt(kilowatt(2.6));
    expect(w).toBe(2600);
  });

  it('does not let the compiler mix units', () => {
    const power = watt(1000);
    const energy = wattHour(1000);
    // @ts-expect-error a plain number is not a Watt
    const notWatt: Watt = 1000;
    // @ts-expect-error watts are not watt-hours
    const notEnergy: WattHour = power;
    expect([notWatt, notEnergy, energy]).toHaveLength(3);
  });

  it('throws on a programming error when a constructor gets an invalid literal', () => {
    expect(() => pct(150)).toThrow();
  });
});

// °F everywhere (owner decision, 9 Oct): one helper for the cards and the voice, so both say the same numbers.
// Absolute temperatures convert with ×1.8 + 32 and round to one decimal; a difference is derived from the rounded
// absolutes, never a K×1.8 rounded on its own, so now − comfort = gap always adds up on screen.
describe('temperatures for people, in °C or °F', () => {
  it('converts absolute temperatures to one decimal', () => {
    const table: readonly [number, TempUnit, number][] = [
      [30.9, 'C', 30.9],
      [30.94, 'C', 30.9],
      [30.9, 'F', 87.6],
      [24, 'F', 75.2],
      [23, 'F', 73.4],
      [0, 'F', 32],
      [-10, 'F', 14],
      [26.7, 'F', 80.1],
    ];
    for (const [c, unit, shown] of table) expect(toDisplayTemp(c, unit)).toBe(shown);
  });

  it('writes the value with its unit; the fixed form always shows one decimal', () => {
    expect(formatTemp(24, 'C')).toBe('24 °C');
    expect(formatTemp(30.9, 'F')).toBe('87.6 °F');
    expect(formatTempFixed(24, 'C')).toBe('24.0 °C');
    expect(formatTempFixed(0, 'F')).toBe('32.0 °F');
  });

  it('a gap comes from the rounded absolutes: now − comfort = gap, in °F too', () => {
    expect(tempGap(30.9, 24, 'F')).toEqual({ now: 87.6, ref: 75.2, gap: 12.4, side: 'above' });
    expect(tempGap(23.6, 24, 'C')).toEqual({ now: 23.6, ref: 24, gap: 0.4, side: 'below' });
    expect(tempGap(24, 24, 'F')).toEqual({ now: 75.2, ref: 75.2, gap: 0, side: 'above' });
    for (const nowC of [24.03, 24.08, 24.95, 25.25, 26.35, 31.45]) {
      const g = tempGap(nowC, 24, 'F');
      expect(Math.round((g.now - g.ref) * 10) / 10).toBe(g.gap);
    }
  });

  it('a value the tools take in °C, said in °F with the °C to send in brackets (#306 review)', () => {
    expect(formatTempForInput(27, 'F')).toBe('80.6 °F (27 C)');
    expect(formatTempForInput(32.2, 'F')).toBe('90 °F (32.2 C)');
    expect(formatTempForInput(27, 'C')).toBe('27 C');
  });

  it('the unit setting is °C or °F, nothing else', () => {
    expect(TempUnitSchema.options).toEqual(['C', 'F']);
  });
});
