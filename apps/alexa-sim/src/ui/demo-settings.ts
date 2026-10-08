import {
  GetDemoSettingsOutputSchema,
  SetScenarioOutputSchema,
  err,
  ok,
  toolError,
  type ErrorEnvelope,
  type Household,
  type LocationId,
  type Result,
  type ScenarioId,
  type SetScenarioInput,
} from '@cold-reserve/contracts';
import type { Agent, AskContext } from '../agent/agent.js';
import { log as defaultLog, type Log } from '../log.js';
import type { Sky } from './sky.js';
import { t } from './text.js';

// B1 (additions plan): what a judge can change in their demo sandbox (C2b, #239): the scenario, the place, the units
// and who is at home. Scripted mode keeps these settings in the page; remote mode reads and writes them (B2).

export interface DemoSettingsView {
  scenarioId: ScenarioId;
  locationId: LocationId;
  units: 'C' | 'F';
  household: Household;
}

export const SCENARIOS: readonly ScenarioId[] = ['clear-day', 'heatwave', 'storm-blackout'];
export const PLACES: readonly LocationId[] = ['reference', 'turin', 'houston'];
export const HOUSEHOLDS: readonly Household[] = ['older-man', 'older-woman', 'no-one-at-risk'];

/** The scripted sandbox: the heat-wave day of the video, at the reference home. */
export function scriptedDemoSettings(): DemoSettingsView {
  return { scenarioId: 'heatwave', locationId: 'reference', units: 'C', household: 'older-man' };
}

export function badgeText(view: DemoSettingsView): string {
  // The place in the page's language at render time (#284), never a label kept from another language.
  return t('settings.badge', { place: t(`settings.place.${view.locationId}`), scenario: t(`settings.scenario.${view.scenarioId}`) });
}

/** The settings after a choice: only what was chosen changes; a restart plays the same day again. */
export function applyChange(view: DemoSettingsView, change: SetScenarioInput): DemoSettingsView {
  return {
    ...view,
    ...(change.scenarioId === undefined ? {} : { scenarioId: change.scenarioId }),
    ...(change.locationId === undefined ? {} : { locationId: change.locationId }),
    ...(change.units === undefined ? {} : { units: change.units }),
    ...(change.household === undefined ? {} : { household: change.household }),
  };
}

/** The sky a scenario starts on (sky.ts keeps following the answers afterwards). */
export function skyOfScenario(id: ScenarioId): Sky {
  if (id === 'storm-blackout') return 'storm';
  return id === 'heatwave' ? 'hot' : 'mild';
}

/** The places the server plays (all three since #280); a place missing here shows "Not available yet". */
export const SHIPPED_PLACES: readonly LocationId[] = ['reference', 'turin', 'houston'];

async function callFor<T>(
  agent: Agent,
  name: 'get_demo_settings' | 'set_scenario',
  args: Record<string, unknown>,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
  context: AskContext,
  logEvent: Log,
): Promise<Result<T, ErrorEnvelope>> {
  try {
    const reply = await agent.callTool(name, args, context);
    if (reply.isError !== true) {
      const parsed = parse(reply.structuredContent);
      if (parsed.success) return ok(parsed.data);
    }
    const failure = reply.isError === true ? toolError('invalid_input', 'The demo settings were refused.') : toolError('output_schema_violation', 'The demo settings came back in an unexpected format.');
    logEvent({ level: 'warn', code: failure.code, correlationId: context.correlationId, details: { step: name } });
    return err(failure);
  } catch (error) {
    const failure = toolError('agent_unavailable', 'The demo settings could not be reached.');
    logEvent({ level: 'warn', code: failure.code, correlationId: context.correlationId, error, details: { step: name } });
    return err(failure);
  }
}

/** B2: the visitor's sandbox settings, read through the card tool route; a home that is not a sandbox has none. */
export async function fetchDemoSettings(agent: Agent, context: AskContext, logEvent: Log = defaultLog): Promise<Result<DemoSettingsView, ErrorEnvelope>> {
  const read = await callFor(agent, 'get_demo_settings', {}, (v) => GetDemoSettingsOutputSchema.safeParse(v), context, logEvent);
  if (!read.ok) return read;
  const { settings } = read.value;
  return ok({ scenarioId: settings.scenarioId, locationId: settings.locationId, units: settings.units, household: settings.household });
}

/** B2: saves one change, then reads the settings back, so what is shown is what is stored (never an optimistic guess). */
export async function saveDemoSettings(agent: Agent, change: SetScenarioInput, context: AskContext, logEvent: Log = defaultLog): Promise<Result<DemoSettingsView, ErrorEnvelope>> {
  const saved = await callFor(agent, 'set_scenario', { ...change }, (v) => SetScenarioOutputSchema.safeParse(v), context, logEvent);
  if (!saved.ok) return saved;
  return fetchDemoSettings(agent, context, logEvent);
}
