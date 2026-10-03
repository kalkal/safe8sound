import { pct, type Forecast, type HomeProfile, type Preferences, type Snapshot } from '@cold-reserve/contracts';
import { holdSafeRoom } from '@cold-reserve/guard';
import { defaultSimParams } from '@cold-reserve/source-simulator';
import { loadComfortPlanConfig } from '../../src/comfort-plan-config.js';
import { guardFrame } from '../../src/modules/comfort-plan/plan-comfort.js';
import type { StormModeConfig } from '../../src/modules/storm-mode/config.js';

const H = 3_600_000;

/**
 * The acceptance rule of #23 on one physics (Q7-A of #24): the guard's hold of the safe room on battery alone,
 * down to the hardware floor, at the limit in force (the night-recovery limit at night), dry or cool by humidity,
 * capped at `capHours`. The same engine and the same limit as the last-resort plan.
 */
export function expectedHold(input: { snapshot: Snapshot; forecast: Forecast; profile: HomeProfile; preferences: Preferences; config: StormModeConfig }): { hours: number; untilMs: number } {
  const { snapshot, forecast, profile, preferences, config } = input;
  const loaded = loadComfortPlanConfig();
  if (!loaded.ok) throw new Error(loaded.error.message);
  const { comfort, guard } = loaded.value;
  const nowMs = Date.parse(snapshot.ts);
  const toMs = nowMs + config.capHours * H;
  const held = holdSafeRoom(
    { snapshot: { ...snapshot, gridAvailable: false }, forecast, profile, preferences, ...guardFrame({ config: comfort }, 'auto', { snapshot, forecast, preferences }), model: defaultSimParams(), config: guard },
    { toMs, dischargeFloorPct: pct(profile.battery.minSocHwPct), humidityBand: comfort.planner.humidityBand, marginK: comfort.planner.essentialMarginK },
  );
  if (!held.ok) throw new Error(held.error.message);
  const untilMs = held.value.safeUntil?.ms ?? toMs;
  return { hours: Math.round(((untilMs - nowMs) / H) * 100) / 100, untilMs };
}

export const expectedSafeHours = (input: Parameters<typeof expectedHold>[0]): number => expectedHold(input).hours;
