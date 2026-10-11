import { categoryOf, type ErrorEnvelope, type Forecast, type HomeId, type Household, type LocationId, type Result, type SandboxSettings, type TempUnit } from '@cold-reserve/contracts';
import type { Logger, StateStoreFactory } from '@cold-reserve/core';
import { builtInPlace, type Place, type Scenario } from '@cold-reserve/source-simulator';
import type { HomeEntry } from './modules/energy-status/index.js';
import { homeDetail } from './sandbox-log.js';

// C2b (#222): what a visitor's sandbox plays, from its settings. Who is at home decides the role in the safe room
// (owner, 3/10): grandpa and grandma are at risk, with the same limits and windows (comfort-plan.json `elderlyRoles`);
// with no one at risk the occupant is an adult. Health thresholds are never settings.

/** The at-risk role the built-in scripts put in the safe room. */
const SCRIPT_ROLE = 'grandpa';

const SAFE_ROOM_ROLE: Record<Household, string> = { 'older-man': 'grandpa', 'older-woman': 'grandma', 'no-one-at-risk': 'adult' };

export const safeRoomRole = (household: Household): string => SAFE_ROOM_ROLE[household];

/** The scenario with the household's role in place of the script's; a new object, the given one is untouched. */
export function withHousehold(scenario: Scenario, household: Household): Scenario {
  const role = safeRoomRole(household);
  if (role === SCRIPT_ROLE) return scenario;
  return { ...scenario, occupancy: scenario.occupancy.map((o) => ({ ...o, roles: o.roles.map((r) => (r === SCRIPT_ROLE ? role : r)) })) };
}

/** A place shipped with the simulator: the reference home, Turin and Houston (L2, #247). Every LocationId ships. */
export const shippedPlace = (id: LocationId): Place => builtInPlace(id);

/** One sandbox as this container plays it. */
export interface SandboxPlay {
  readonly entry: HomeEntry;
  readonly forecast: () => Forecast;
  /** The settings version played; absent: the built-in defaults. */
  readonly version?: number;
  /** The temperature unit the visitor chose (#306): the tool texts follow it. */
  readonly units: TempUnit;
  /** The scenario played and the instant it starts (its start hour included): the judges' clock reads its day (#311). */
  readonly scenario: Scenario;
  readonly startMs: number;
  /** The missing settings were reported for this build (one warning per build, C2b Q3). */
  missingReported?: boolean;
}

type Play = (homeId: HomeId, settings: SandboxSettings) => Result<SandboxPlay, ErrorEnvelope>;

/**
 * Brings a sandbox up to date with its stored settings, one read per request (C2b Q3), so every container plays a
 * change at its next request. A failure is logged and the sandbox keeps playing what it played (its degraded mode).
 */
export function refreshFrom(storeFor: StateStoreFactory, play: Play, logger: Logger): (homeId: HomeId, current: SandboxPlay, correlationId: string) => Promise<SandboxPlay> {
  const warn = (homeId: HomeId, correlationId: string, error: ErrorEnvelope, event: string, message: string, level: 'warn' | 'error' = 'warn') => {
    logger.log({
      ts: new Date().toISOString(),
      level,
      component: 'mcp-server',
      message,
      correlationId,
      code: error.code,
      category: categoryOf(error.code),
      details: { event, ...homeDetail(homeId) },
    });
  };
  return async (homeId, current, correlationId) => {
    const read = await storeFor(homeId, { correlationId }).getSandboxSettings();
    if (!read.ok) {
      if (read.error.code !== 'settings_not_found') {
        warn(homeId, correlationId, read.error, 'settings_read_failed', 'The sandbox settings could not be read: the sandbox keeps what it plays.');
      } else if (current.version === undefined && current.missingReported !== true) {
        current.missingReported = true;
        warn(homeId, correlationId, read.error, 'settings_missing', 'No settings saved for this sandbox yet: it plays the defaults.');
      }
      return current;
    }
    if (read.value.version === current.version) return current;
    const next = play(homeId, read.value);
    if (!next.ok) {
      warn(homeId, correlationId, next.error, 'settings_play_failed', 'The saved sandbox settings cannot be played: the sandbox keeps what it plays.', 'error');
      return current;
    }
    return next.value;
  };
}
