import { z } from 'zod';
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
