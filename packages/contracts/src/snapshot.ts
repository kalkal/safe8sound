import { z } from 'zod';
import { EntityIdSchema, HomeIdSchema, IsoDateTimeSchema, RoleSchema, uniqueBy } from './common.js';
import { HvacModeSchema } from './home.js';
import { DataOriginSchema } from './origin.js';
import { CelsiusSchema, PctSchema, RatioSchema, WattSchema } from './units.js';

export const SNAPSHOT_SCHEMA_VERSION = 1;

export const HomeLinkSchema = z.enum(['ok', 'stale', 'lost']);
export type HomeLink = z.infer<typeof HomeLinkSchema>;

export const RoomReadingSchema = z.strictObject({
  id: EntityIdSchema,
  tempC: CelsiusSchema,
  humidityPct: PctSchema.optional(),
  co2Ppm: z.number().nonnegative().optional(),
  pm25: z.number().nonnegative().optional(),
  /** Roles only ("grandpa"), never names. */
  occupants: z.array(RoleSchema).max(20),
  hvac: z
    .strictObject({
      mode: HvacModeSchema,
      setpointC: CelsiusSchema,
      preset: z.string().regex(/^[a-z_]{1,24}$/).optional(),
    })
    .optional(),
  fanOn: z.boolean().optional(),
});
export type RoomReading = z.infer<typeof RoomReadingSchema>;

/** One measurement of the home. `ts` is the measurement time, not the send time (plan §9.4). */
export const SnapshotSchema = z.strictObject({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  homeId: HomeIdSchema,
  ts: IsoDateTimeSchema,
  pvW: WattSchema,
  loadW: WattSchema,
  batterySocPct: PctSchema,
  /** Positive = import from the grid, negative = export. */
  gridW: WattSchema,
  /** Measured (or switched off by a scenario). The only thing that unlocks the storm reserve. */
  gridAvailable: z.boolean(),
  rooms: z.array(RoomReadingSchema).refine((rooms) => uniqueBy(rooms, (r) => r.id), { message: 'Room ids must be unique' }),
  /** The temperature outside at the reading, when the source knows it (additive, owner 20 Oct: the Echo's top bar). */
  outdoorTempC: CelsiusSchema.optional(),
  origin: DataOriginSchema,
  homeLink: HomeLinkSchema,
  lastLiveAt: IsoDateTimeSchema.optional(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const ForecastConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type ForecastConfidence = z.infer<typeof ForecastConfidenceSchema>;

export const ForecastSchema = z.strictObject({
  fetchedAt: IsoDateTimeSchema,
  /** A category with its reason, never a percentage (plan §11.2 p.6). */
  confidence: ForecastConfidenceSchema,
  confidenceReason: z.string().min(1).max(200),
  hourly: z.array(
    z.strictObject({
      ts: IsoDateTimeSchema,
      tempOutC: CelsiusSchema,
      humidityOutPct: PctSchema,
      irradianceWm2: z.number().nonnegative(),
      stormProb: RatioSchema,
    }),
  ),
  sunrise: z.array(IsoDateTimeSchema),
  sunset: z.array(IsoDateTimeSchema),
});
export type Forecast = z.infer<typeof ForecastSchema>;
