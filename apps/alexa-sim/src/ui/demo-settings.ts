import {
  GetDemoSettingsOutputSchema,
  SetScenarioOutputSchema,
  defaultUnitOf,
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
import { HOUSEHOLD_CHOICES, isTimeZone, playedHousehold } from '@cold-reserve/core';
import type { AvatarKind } from '@cold-reserve/ui-cards/avatars';
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
  /**
   * IANA zone of the sandbox's place (Houston: America/Chicago): every time on screen is on the home's own clock,
   * never the browser's or the page's configured zone. Unknown in scripted mode and right after a new place is chosen there.
   */
  timeZone?: string;
}

export const SCENARIOS: readonly ScenarioId[] = ['clear-day', 'heatwave', 'storm-blackout'];
export const PLACES: readonly LocationId[] = ['reference', 'turin', 'houston'];
/** Who is at home (owner, 20 Oct): an older man, or no one at risk (core's HOUSEHOLD_CHOICES). */
export const HOUSEHOLDS: readonly Household[] = HOUSEHOLD_CHOICES;

/**
 * The home as the Echo and the settings show it (owner, 20 Oct, B and A): Leo, his line in "Who we protect" and his name
 * in the greeting, the safe-room tile and the phone; or, with no one at risk at home, a small house, a line that says so
 * and neutral words (`named` false). One rule for every place.
 */
export interface HomeFace {
  avatar: AvatarKind;
  who: 'settings.protect.leo' | 'settings.protect.noOne';
  /** Whether the texts name Leo (the greeting, the safe-room tile, the phone's settings line). */
  named: boolean;
}

export function homeFaceOf(household: Household | undefined): HomeFace {
  return household !== undefined && playedHousehold(household) === 'no-one-at-risk' ? { avatar: 'home', who: 'settings.protect.noOne', named: false }
    : { avatar: 'older-man', who: 'settings.protect.leo', named: true };
}

/** The scripted sandbox: the heat-wave day of the video, at the reference home. */
export function scriptedDemoSettings(): DemoSettingsView {
  return { scenarioId: 'heatwave', locationId: 'reference', units: 'C', household: 'older-man' };
}

/**
 * What the clock bar and the judges' panel say with nothing ahead. The clear day has no moment from its 12:00 start to
 * midnight (no outage; the recharge is the next morning): it points the judges to the scenarios that have some (20 Oct).
 */
export function nothingAheadText(scenarioId: ScenarioId | undefined, otherwise: 'clock.nothingNext' | 'demoControls.nothingNext'): string {
  return t(scenarioId === 'clear-day' ? 'clock.nothingClearDay' : otherwise);
}

export function badgeText(view: DemoSettingsView): string {
  // The place in the page's language at render time (#284), never a label kept from another language.
  return t('settings.badge', { place: t(`settings.place.${view.locationId}`), scenario: t(`settings.scenario.${view.scenarioId}`) });
}

/**
 * The settings after a choice: only what was chosen changes; a restart plays the same day again. A new place starts
 * in its own unit (°F everywhere, owner decision, 9 Oct: Houston in °F), unless a unit is chosen with it.
 */
export function applyChange(view: DemoSettingsView, change: SetScenarioInput): DemoSettingsView {
  const placeUnit = change.locationId === undefined || change.locationId === view.locationId ? undefined : defaultUnitOf(change.locationId);
  const units = change.units ?? placeUnit;
  // A new place: its zone is no longer the old place's (remote mode reads the new one back at once).
  const base: DemoSettingsView = { ...view };
  if (placeUnit !== undefined) delete base.timeZone;
  return {
    ...base,
    ...(change.scenarioId === undefined ? {} : { scenarioId: change.scenarioId }),
    ...(change.locationId === undefined ? {} : { locationId: change.locationId }),
    ...(units === undefined ? {} : { units }),
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

export async function callFor<T>(
  agent: Agent,
  name: 'get_demo_settings' | 'set_scenario' | 'get_preferences' | 'set_preferences',
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
  const { settings, place } = read.value;
  // The zone is host data: one this browser does not know is left out, and the page keeps its configured zone.
  return ok({ scenarioId: settings.scenarioId, locationId: settings.locationId, units: settings.units, household: playedHousehold(settings.household), ...(isTimeZone(place.tz) ? { timeZone: place.tz } : {}) });
}

/** B2: saves one change, then reads the settings back, so what is shown is what is stored (never an optimistic guess). */
export async function saveDemoSettings(agent: Agent, change: SetScenarioInput, context: AskContext, logEvent: Log = defaultLog): Promise<Result<DemoSettingsView, ErrorEnvelope>> {
  const saved = await callFor(agent, 'set_scenario', { ...change }, (v) => SetScenarioOutputSchema.safeParse(v), context, logEvent);
  if (!saved.ok) return saved;
  return fetchDemoSettings(agent, context, logEvent);
}
