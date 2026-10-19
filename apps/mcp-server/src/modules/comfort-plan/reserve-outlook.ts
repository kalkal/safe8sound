import { ok, type ErrorEnvelope, type Level, type ReserveOutlook, type Result } from '@cold-reserve/contracts';
import { reserveOutlookHours } from '@cold-reserve/core';
import { reserveOf } from '@cold-reserve/guard';
import { localIso } from '@cold-reserve/core';
import type { ToolContext } from '../../tool.js';
import type { ComfortPlanDeps } from './deps.js';
import { loadInputs } from './plan-comfort.js';

// get_reserve_outlook: the reserve counted in hours for the ice-cube card (semantics agreed in #21).
// The reserve and its floor are the guard's own (reserveOf). The level is the one get_home_status shows: during a storm
// the storm's own (saver from the grid loss, essential from the essential moment, #444); otherwise, until the level is
// persisted (LEVEL#CURRENT) no plan moves it, so it is the comfort the person chose.

const CHOSEN_LEVEL: Level = 'comfort';

export async function reserveOutlook(deps: ComfortPlanDeps, _input: Record<string, never>, ctx: ToolContext): Promise<Result<ReserveOutlook, ErrorEnvelope>> {
  const loaded = await loadInputs(deps, ctx);
  if (!loaded.ok) return loaded;
  const level: Level = (await deps.stormLevel?.(ctx))?.level ?? CHOSEN_LEVEL;
  const { snapshot, forecast, profile } = loaded.value;
  const reserve = reserveOf({ snapshot, forecast, profile, model: deps.model, config: deps.guard });
  const loads = { ...deps.config.outlook.levelLoadW, essential: deps.guard.reserve.essentialLoadW };
  const hours = reserveOutlookHours({
    battery: profile.battery,
    socPct: snapshot.batterySocPct,
    gridAvailable: snapshot.gridAvailable,
    reserveFloorSocPct: reserve.reserveFloorSocPct,
    reserveWh: reserve.reserveWh,
    currentLoadW: loads[level],
    essentialLoadW: loads.essential,
  });
  // In the home's time zone, as every other time the person hears (#160).
  return ok({ level, ...hours, gridAvailable: snapshot.gridAvailable, origin: snapshot.origin, ts: localIso(Date.parse(snapshot.ts), profile.location.tz) });
}
