import type { PlanWarning } from '@cold-reserve/contracts';
import { driedInto, type GuardContext } from './context.js';

// Dry air the plan did not cause (#107): cooling and fans cannot raise the humidity, so a safe room below the
// person's minimum while the plan is not drying it is said, with what helps, instead of refusing the plan.

const MINUTE_MS = 60_000;

export function dryAirWarning(ctx: GuardContext): PlanWarning | undefined {
  const { preferences, profile, config } = ctx.input;
  const minPct = preferences.safety.humidity.minPct;
  const fromMs = ctx.nowMs + config.safeRoom.graceMinutes * MINUTE_MS;
  const dry = ctx.points
    .filter((p) => p.ms >= fromMs && !driedInto(ctx)(p.ms))
    .flatMap((p) => p.rooms.filter((r) => r.id === preferences.safeRoomId))
    .map((r) => r.humidityPct)
    .filter((rh) => rh < minPct);
  if (dry.length === 0) return undefined;
  const room = profile.rooms.find((r) => r.id === preferences.safeRoomId)?.name ?? preferences.safeRoomId;
  return {
    code: 'dry_air',
    message: `The air in the ${room} is dry (down to ${Math.round(Math.min(...dry)).toString()} %, under ${minPct.toString()} %) and cooling cannot raise it: drink water; a damp cloth or a bowl of water in the room helps.`.slice(0, 300),
  };
}
