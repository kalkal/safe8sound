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
