import type { Household, LocationId, ScenarioId, SetScenarioInput } from '@cold-reserve/contracts';
import type { Sky } from './sky.js';
import { t } from './text.js';

// B1 (additions plan): what a judge can change in their demo sandbox (C2b, #239): the scenario, the place, the units
// and who is at home. Scripted mode keeps these settings in the page; remote mode reads and writes them (B2).

export interface DemoSettingsView {
  scenarioId: ScenarioId;
  locationId: LocationId;
  units: 'C' | 'F';
  household: Household;
  /** The place as the server names it (get_demo_settings' place.label). */
  placeLabel: string;
}

export const SCENARIOS: readonly ScenarioId[] = ['clear-day', 'heatwave', 'storm-blackout'];
export const PLACES: readonly LocationId[] = ['reference', 'turin', 'houston'];
export const HOUSEHOLDS: readonly Household[] = ['older-man', 'older-woman', 'no-one-at-risk'];

/** The scripted sandbox: the heat-wave day of the video, at the reference home. */
export function scriptedDemoSettings(): DemoSettingsView {
  return { scenarioId: 'heatwave', locationId: 'reference', units: 'C', household: 'older-man', placeLabel: t('settings.place.reference') };
}

export function badgeText(view: DemoSettingsView): string {
  return t('settings.badge', { place: view.placeLabel, scenario: t(`settings.scenario.${view.scenarioId}`) });
}

/** The settings after a choice: only what was chosen changes; a restart plays the same day again. */
export function applyChange(view: DemoSettingsView, change: SetScenarioInput): DemoSettingsView {
  return {
    ...view,
    ...(change.scenarioId === undefined ? {} : { scenarioId: change.scenarioId }),
    ...(change.locationId === undefined ? {} : { locationId: change.locationId, placeLabel: t(`settings.place.${change.locationId}`) }),
    ...(change.units === undefined ? {} : { units: change.units }),
    ...(change.household === undefined ? {} : { household: change.household }),
  };
}

/** The sky a scenario starts on (sky.ts keeps following the answers afterwards). */
export function skyOfScenario(id: ScenarioId): Sky {
  if (id === 'storm-blackout') return 'storm';
  return id === 'heatwave' ? 'hot' : 'mild';
}
