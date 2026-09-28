import { describe, expect, it } from 'vitest';
import {
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
