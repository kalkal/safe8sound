import type { PlanWarning } from '@cold-reserve/contracts';
import type { GuardContext } from './context.js';

// Humid air without heat danger (#248, approved in #248): above the person's humidity maximum (60 % by default, the
// US EPA's indoor guidance against mould, https://www.epa.gov/mold/brief-guide-mold-moisture-and-your-home) the room
// is less comfortable and mould may grow, but humidity alone is not a heat danger: heat-danger.ts decides that.
// Said on an accepted plan, never a refusal.

const MINUTE_MS = 60_000;

export function humidAirWarning(ctx: GuardContext): PlanWarning | undefined {
  const { preferences, profile, config } = ctx.input;
  const maxPct = preferences.safety.humidity.maxPct;
  const fromMs = ctx.nowMs + config.safeRoom.graceMinutes * MINUTE_MS;
  const humid = ctx.points
    .filter((p) => p.ms >= fromMs)
    .flatMap((p) => p.rooms.filter((r) => r.id === preferences.safeRoomId))
    .map((r) => r.humidityPct)
    .filter((rh) => rh > maxPct);
  if (humid.length === 0) return undefined;
  const room = profile.rooms.find((r) => r.id === preferences.safeRoomId)?.name ?? preferences.safeRoomId;
  return {
    code: 'humid_air',
    message: `The air in the ${room} is humid (up to ${Math.round(Math.max(...humid)).toString()} %, over ${maxPct.toString()} %): less comfortable and a risk of mould, but no heat danger at this temperature.`.slice(0, 300),
  };
}
