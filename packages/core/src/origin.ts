import { DATA_GROUPS, type DataGroup, type DataOrigin } from '@cold-reserve/contracts';

/** A scenario and the field groups it replaces with simulated data, even over a live home. */
export interface ScenarioOverlay {
  readonly id: string;
  readonly simulatedGroups: readonly DataGroup[];
}

/**
 * Per-group data origin (plan §9.4): a group is live only if the source has it live and no scenario
 * overrides it. A storm/blackout scenario lists every group, so it is always fully simulated.
 * The scenario name is kept only when some group is simulated (contracts: `DataOriginSchema`).
 */
export function resolveOrigin(liveGroups: readonly DataGroup[], scenario?: ScenarioOverlay): DataOrigin {
  const isLive = (g: DataGroup) => liveGroups.includes(g) && !(scenario?.simulatedGroups.includes(g) ?? false);
  const origin: DataOrigin = {
    energy: isLive('energy') ? 'live' : 'simulated',
    rooms: isLive('rooms') ? 'live' : 'simulated',
    weather: isLive('weather') ? 'live' : 'simulated',
  };
  const anySimulated = DATA_GROUPS.some((g) => origin[g] === 'simulated');
  return scenario !== undefined && anySimulated ? { ...origin, scenario: scenario.id } : origin;
}
