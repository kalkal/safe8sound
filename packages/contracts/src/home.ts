import { z } from 'zod';
import { EntityIdSchema, HomeIdSchema, uniqueBy } from './common.js';
import { KilowattSchema, PctSchema, RatioSchema, WattHourSchema, WattSchema } from './units.js';

export const HOME_SCHEMA_VERSION = 1;

/** Home Assistant `climate` HVAC modes (plan §4ter). "eco" is a preset, not a mode. */
export const HvacModeSchema = z.enum(['cool', 'heat', 'dry', 'fan_only', 'heat_cool', 'auto', 'off']);
export type HvacMode = z.infer<typeof HvacModeSchema>;

export const ControlPathSchema = z.enum(['cloud', 'local', 'manual']);
export type ControlPath = z.infer<typeof ControlPathSchema>;

export const HvacUnitSchema = z.strictObject({
  id: EntityIdSchema,
  model: z.string().min(1).max(80),
  coolingKw: KilowattSchema,
  inputKw: z
    .strictObject({ min: KilowattSchema, nominal: KilowattSchema, max: KilowattSchema })
    .refine((p) => p.min <= p.nominal && p.nominal <= p.max, { message: 'Expected min <= nominal <= max' }),
  modes: z
    .array(HvacModeSchema)
    .min(1)
    .refine((modes) => new Set(modes).size === modes.length, { message: 'Modes must be unique' }),
  controlPath: ControlPathSchema,
});
export type HvacUnit = z.infer<typeof HvacUnitSchema>;

export const FanUnitSchema = z.strictObject({
  id: EntityIdSchema,
  powerW: WattSchema.refine((w) => w > 0, { message: 'Fan power must be positive' }),
  controllable: z.boolean(),
});
export type FanUnit = z.infer<typeof FanUnitSchema>;

export const RoomSchema = z.strictObject({
  id: EntityIdSchema,
  name: z.string().min(1).max(40),
  isSafeRoom: z.boolean(),
  /** 1R1C thermal model: resistance in K/kW, capacitance in kWh/K (spike S6). */
  thermal: z.strictObject({
    rKPerKw: z.number().positive(),
    cKwhPerK: z.number().positive(),
  }),
  hvacUnits: z.array(HvacUnitSchema),
  fans: z.array(FanUnitSchema),
  presenceSensorId: EntityIdSchema.optional(),
  climateSensorId: EntityIdSchema.optional(),
});
export type Room = z.infer<typeof RoomSchema>;

const roundedToOneDecimal = (n: number) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-9;

/** The plant and the rooms. Every number here is data from the home profile, never a constant in code. */
export const HomeProfileSchema = z
  .strictObject({
    schemaVersion: z.literal(HOME_SCHEMA_VERSION),
    homeId: HomeIdSchema,
    inverterMaxAcW: WattSchema,
    eps: z.strictObject({
      continuousVa: z.number().positive(),
      peakVa: z.number().positive(),
      peakSeconds: z.number().positive(),
    }),
    battery: z
      .strictObject({
        nominalWh: WattHourSchema,
        usableWh: WattHourSchema,
        minSocHwPct: PctSchema.refine((p) => p < 100, { message: 'Minimum SOC must be below 100%' }),
        maxChargeW: WattSchema,
        maxDischargeW: WattSchema,
        roundTripEff: RatioSchema,
      })
      .refine((b) => b.usableWh <= b.nominalWh, { path: ['usableWh'], message: 'Usable capacity exceeds nominal' }),
    pvPeakW: WattSchema,
    rooms: z
      .array(RoomSchema)
      .min(1)
      .refine((rooms) => uniqueBy(rooms, (r) => r.id), { message: 'Room ids must be unique' }),
    epsCircuits: z.array(z.string().min(1).max(40)),
    /** Rounded to one decimal (about 10 km): never the precise location. */
    location: z.strictObject({
      latRounded: z.number().min(-90).max(90).refine(roundedToOneDecimal, { message: 'Round to one decimal' }),
      lonRounded: z.number().min(-180).max(180).refine(roundedToOneDecimal, { message: 'Round to one decimal' }),
      tz: z.string().min(1).max(64),
    }),
  });
export type HomeProfile = z.infer<typeof HomeProfileSchema>;
