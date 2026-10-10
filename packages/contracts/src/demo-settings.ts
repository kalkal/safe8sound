import { z } from 'zod';
import { IsoDateTimeSchema } from './common.js';
import { PlanIdSchema } from './plan.js';
import { HouseholdSchema, LocationIdSchema, SandboxSettingsSchema, ScenarioIdSchema } from './sandbox-settings.js';
import { TempUnitSchema } from './units.js';

// C2b (#222, approved in #222): a visitor's sandbox settings as two tools, get_demo_settings and set_scenario. Only
// visitor sandboxes list them; health thresholds are never among them (C1).

/** Output of `get_demo_settings`: the settings and the place the scenario is played in. */
export const GetDemoSettingsOutputSchema = z.strictObject({
  settings: SandboxSettingsSchema,
  place: z.strictObject({ id: LocationIdSchema, label: z.string().min(1).max(64), tz: z.string().min(1).max(64) }),
});
export type GetDemoSettingsOutput = z.infer<typeof GetDemoSettingsOutputSchema>;

/** Input of `set_scenario`: what the visitor chose; at least one change, or a restart of the day. */
export const SetScenarioInputSchema = z
  .strictObject({
    scenarioId: ScenarioIdSchema.optional(),
    locationId: LocationIdSchema.optional(),
    units: TempUnitSchema.optional(),
    household: HouseholdSchema.optional(),
    restart: z.boolean().optional().describe('true to play the day again from its start.'),
  })
  .refine((i) => i.scenarioId !== undefined || i.locationId !== undefined || i.units !== undefined || i.household !== undefined || i.restart === true, {
    message: 'Choose at least one setting, or restart the day.',
  });
export type SetScenarioInput = z.infer<typeof SetScenarioInputSchema>;

/** Output of `set_scenario`: the settings as now stored (a new version) and whether the day started again. */
export const SetScenarioOutputSchema = z.strictObject({
  settings: SandboxSettingsSchema,
  restarted: z.boolean(),
});
export type SetScenarioOutput = z.infer<typeof SetScenarioOutputSchema>;

/**
 * The judges' clock (#311, additive, approved in #311): the next interesting moments of the visitor's own sandbox,
 * from the scenario's grid outages and the plan's own fields. `label` is an English fallback (the page names each
 * kind in its language) and never carries a temperature.
 */
export const MilestoneKindSchema = z.enum([
  'pre_cooling_start',
  'surplus_start',
  'surplus_end',
  'storm_start',
  'power_back',
  'essential_level',
  'limit_crossed',
  'last_resort_end',
  'next_recharge',
]);
export type MilestoneKind = z.infer<typeof MilestoneKindSchema>;

export const MilestoneSchema = z.strictObject({
  kind: MilestoneKindSchema,
  /** In the home's zone, with its offset. */
  at: IsoDateTimeSchema,
  label: z.string().min(1).max(80),
});
export type Milestone = z.infer<typeof MilestoneSchema>;

/** At most this many milestones, the next 24 hours in time order. */
export const MAX_MILESTONES = 12;

/** Input of `get_milestones`: the plan whose moments to list, which must be the sandbox's own. */
export const GetMilestonesInputSchema = z.strictObject({
  planId: PlanIdSchema.optional().describe("A plan of this sandbox: its own moments are listed too. Without it, the scenario's moments only."),
});
export type GetMilestonesInput = z.infer<typeof GetMilestonesInputSchema>;

/** Output of `get_milestones`: the sandbox's time now, the scenario's day (start and 24 h horizon), the moments. */
export const GetMilestonesOutputSchema = z.strictObject({
  now: IsoDateTimeSchema,
  day: z.strictObject({ from: IsoDateTimeSchema, to: IsoDateTimeSchema }),
  milestones: z.array(MilestoneSchema).max(MAX_MILESTONES),
});
export type GetMilestonesOutput = z.infer<typeof GetMilestonesOutputSchema>;

/** The longest single jump, in hours. */
export const MAX_ADVANCE_HOURS = 24;

/**
 * Input of `advance_clock`: a listed milestone (its kind and time are its identity) or a number of hours. Never
 * backwards: a restart (`set_scenario` with `restart: true`) is the only way back.
 */
export const AdvanceClockInputSchema = z
  .strictObject({
    kind: MilestoneKindSchema.optional(),
    at: IsoDateTimeSchema.optional().describe('The time of the listed milestone, as get_milestones gave it.'),
    hours: z.number().int().min(1).max(MAX_ADVANCE_HOURS).optional().describe('How many hours ahead, 1 to 24.'),
    planId: PlanIdSchema.optional().describe("A plan of this sandbox: its milestones may be chosen, and its essential level is crossed on the way."),
  })
  .refine((i) => (i.hours === undefined ? i.kind !== undefined && i.at !== undefined : i.kind === undefined && i.at === undefined), {
    message: 'Choose a milestone (kind and at) or a number of hours, not both.',
  });
export type AdvanceClockInput = z.infer<typeof AdvanceClockInputSchema>;

/** Output of `advance_clock`: the sandbox's new time and the settings version that plays it. */
export const AdvanceClockOutputSchema = z.strictObject({
  now: IsoDateTimeSchema,
  settingsVersion: z.number().int().min(1),
});
export type AdvanceClockOutput = z.infer<typeof AdvanceClockOutputSchema>;
