import { z } from 'zod';
import { IsoDateTimeSchema } from './common.js';
import { TempUnitSchema, type TempUnit } from './units.js';

// C1 (#214, approved in #214): what a visitor may choose for their own sandbox home. Health thresholds are not
// settings: the guard's limits stay in its own config. Structural bounds only.

/** The built-in scenarios (the script of a day): moved here from the simulator so contracts can name them. */
export const ScenarioIdSchema = z.enum(['clear-day', 'heatwave', 'storm-blackout']);
export type ScenarioId = z.infer<typeof ScenarioIdSchema>;

/** The places a scenario can happen in (plan §L1): `reference` keeps today's numbers. */
export const LocationIdSchema = z.enum(['reference', 'turin', 'houston']);
export type LocationId = z.infer<typeof LocationIdSchema>;

/** The unit a place starts in (°F everywhere, owner decision, 9 Oct): Houston in °F, the others in °C. */
export const defaultUnitOf = (id: LocationId): TempUnit => (id === 'houston' ? 'F' : 'C');

/** Who is at home in the safe room: decides whose comfort the plan protects first. */
export const HouseholdSchema = z.enum(['older-man', 'older-woman', 'no-one-at-risk']);
export type Household = z.infer<typeof HouseholdSchema>;

export const SandboxSettingsSchema = z.strictObject({
  /** Raised by one on every write; a write names the version it read (conditional write). */
  version: z.number().int().min(1),
  updatedAt: IsoDateTimeSchema,
  scenarioId: ScenarioIdSchema,
  locationId: LocationIdSchema,
  units: TempUnitSchema,
  household: HouseholdSchema,
  /** The battery when the storm scenario starts, in %, or the configured reserve. */
  stormStartSoc: z.union([z.number().int().min(30).max(100), z.literal('from-reserve')]).optional(),
  /**
   * The wall instant the visitor last started the day from (C2b, approved in #222): set on a restart and on a
   * new scenario or place, so every container plays the same hour. Absent: the shared timeline's start.
   */
  scenarioStartedAt: IsoDateTimeSchema.optional(),
  /**
   * The judges' clock (#311, additive, approved in #311): scenario ms the visitor jumped ahead, added to the scenario
   * start. The playthrough anchor never changes with it; a restart sets it back to 0. Absent: 0.
   */
  advancedMs: z.number().int().nonnegative().optional(),
});
export type SandboxSettings = z.infer<typeof SandboxSettingsSchema>;
