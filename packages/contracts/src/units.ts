import { z } from 'zod';

// Branded units (plan §9.1): the compiler refuses W + Wh or a 0-1 fraction where 0-100 is expected.
// Casting to a unit (`as Watt`) is allowed only inside this package (lint rule).

// Zod 4 numbers already reject NaN and infinities.

/** Power in watts. Signed: negative values are flows in the other direction (export, discharge). */
export const WattSchema = z.number().brand<'Watt'>();
export type Watt = z.infer<typeof WattSchema>;

/** Power rating in kilowatts, as datasheets give it. Convert with `kilowattToWatt` before any arithmetic. */
export const KilowattSchema = z.number().nonnegative().brand<'Kilowatt'>();
export type Kilowatt = z.infer<typeof KilowattSchema>;

/** Energy in watt-hours. */
export const WattHourSchema = z.number().nonnegative().brand<'WattHour'>();
export type WattHour = z.infer<typeof WattHourSchema>;

/** Percentage on the 0-100 scale (state of charge, relative humidity). */
export const PctSchema = z.number().min(0).max(100).brand<'Pct'>();
export type Pct = z.infer<typeof PctSchema>;

/** Temperature in degrees Celsius, bounded to physically plausible indoor/outdoor air. */
export const CelsiusSchema = z.number().min(-60).max(80).brand<'Celsius'>();
export type Celsius = z.infer<typeof CelsiusSchema>;

/** Duration in minutes. */
export const MinutesSchema = z.number().nonnegative().brand<'Minutes'>();
export type Minutes = z.infer<typeof MinutesSchema>;

/** Dimensionless ratio on the 0-1 scale (efficiencies, probabilities). */
export const RatioSchema = z.number().min(0).max(1);

// Constructors for literals in code and tests. An invalid literal is a programming error, so they throw.
export const watt = (n: number): Watt => WattSchema.parse(n);
export const kilowatt = (n: number): Kilowatt => KilowattSchema.parse(n);
export const wattHour = (n: number): WattHour => WattHourSchema.parse(n);
export const pct = (n: number): Pct => PctSchema.parse(n);
export const celsius = (n: number): Celsius => CelsiusSchema.parse(n);
export const minutes = (n: number): Minutes => MinutesSchema.parse(n);

// Rounded to the milliwatt so 0.97 kW gives 970 W, not 969.9999999999999.
export const kilowattToWatt = (kw: Kilowatt): Watt => (Math.round(kw * 1_000_000) / 1000) as Watt;

/** Units a guarantee or an error detail may quote next to a number. */
export const MeasureUnitSchema = z.enum(['W', 'Wh', '%', 'C', 'min']);
export type MeasureUnit = z.infer<typeof MeasureUnitSchema>;

/** The temperature unit a person chose (sandbox settings): every figure they read or hear follows it. */
export const TempUnitSchema = z.enum(['C', 'F']);
export type TempUnit = z.infer<typeof TempUnitSchema>;

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * An absolute temperature (°C in) as a person reads it, to one decimal: °F is ×1.8 + 32. One helper for the cards
 * and the voice (owner decision, 9 Oct), so both say the same numbers.
 */
export const toDisplayTemp = (c: number, unit: TempUnit): number => round1(unit === 'F' ? c * 1.8 + 32 : c);

/** "24 °C", "87.6 °F": no trailing zero. */
export const formatTemp = (c: number, unit: TempUnit): string => `${String(toDisplayTemp(c, unit))} °${unit}`;

/** "24.0 °C": always one decimal, next to other one-decimal figures. */
export const formatTempFixed = (c: number, unit: TempUnit): string => `${toDisplayTemp(c, unit).toFixed(1)} °${unit}`;

/**
 * A temperature against a reference (the comfort, a limit), as shown: the gap is derived from the rounded absolutes,
 * never a difference ×1.8 rounded on its own, so now − ref = gap always adds up on screen and in the voice.
 */
export function tempGap(nowC: number, refC: number, unit: TempUnit): { now: number; ref: number; gap: number; side: 'above' | 'below' } {
  const now = toDisplayTemp(nowC, unit);
  const ref = toDisplayTemp(refC, unit);
  return { now, ref, gap: round1(Math.abs(now - ref)), side: now >= ref ? 'above' : 'below' };
}
