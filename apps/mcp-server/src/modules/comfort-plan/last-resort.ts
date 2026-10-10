import { LAST_RESORT_ACTIONS, formatTemp, type LastResortAction, type Season, type TempUnit } from '@cold-reserve/contracts';
import type { SafeRoomLimitKind } from '@cold-reserve/guard';

// The honest window of a last resort (#160): from safeUntil on, how far past its limit the safe room goes and
// by when, along the projection of the chosen plan.

interface WindowPoint {
  readonly ms: number;
  readonly rooms: readonly { readonly id: string; readonly tempC: number }[];
}

export interface WindowOptions {
  readonly untilMs: number;
  readonly roomId: string;
  readonly season: Season;
  /** The temperature limit in force at an instant: the cooling maximum (lowered at night) or the heating minimum. */
  readonly limitAt: (ms: number) => number;
}

export interface LastResortWindow {
  /** The limit in force at the worst point. */
  readonly comfortLimitC: number;
  /** Rounded to one decimal, as it is said. */
  readonly worstC: number;
  readonly worstAtMs: number;
}

/**
 * From safeUntil on, the warmest (the coldest when heating) point of the safe room that is past the limit in
 * force at that point, the earliest on a tie, with that limit. Undefined when no such point is past its limit
 * once rounded as it is said, or the projection has none. It says nothing of the time before safeUntil.
 */
export function lastResortWindow(points: readonly WindowPoint[], opts: WindowOptions): LastResortWindow | undefined {
  const heating = opts.season === 'heating';
  const past = (tempC: number, limitC: number) => (heating ? tempC < limitC : tempC > limitC);
  let worst: { tempC: number; ms: number; limitC: number } | undefined;
  for (const p of points) {
    if (p.ms < opts.untilMs) continue;
    const room = p.rooms.find((r) => r.id === opts.roomId);
    if (room === undefined) continue;
    const limitC = opts.limitAt(p.ms);
    if (!past(room.tempC, limitC)) continue;
    if (worst === undefined || (heating ? room.tempC < worst.tempC : room.tempC > worst.tempC)) worst = { tempC: room.tempC, ms: p.ms, limitC };
  }
  if (worst === undefined) return undefined;
  const worstC = Math.round(worst.tempC * 10) / 10;
  return past(worstC, worst.limitC) ? { comfortLimitC: worst.limitC, worstC, worstAtMs: worst.ms } : undefined;
}

/**
 * After the battery runs out, the room holds its temperature for a while (#272): the first point from safeUntil on
 * whose room is past the limit in force there, once rounded as it is said, from the same projection as the window.
 * Undefined when the room stays inside its limit to the end of the projection. With the limit crossed there (#272 review).
 */
export function limitCrossedAt(points: readonly WindowPoint[], opts: WindowOptions): { readonly atMs: number; readonly limitC: number } | undefined {
  const heating = opts.season === 'heating';
  for (const p of points) {
    if (p.ms < opts.untilMs) continue;
    const room = p.rooms.find((r) => r.id === opts.roomId);
    if (room === undefined) continue;
    const said = Math.round(room.tempC * 10) / 10;
    const limitC = opts.limitAt(p.ms);
    if (heating ? said < limitC : said > limitC) return { atMs: p.ms, limitC };
  }
  return undefined;
}

/**
 * When cooling: the limit at safeUntil if the safe hours end because it came down there (the night threshold),
 * not because the room crossed it: lower than at the step before, the room inside the earlier limit and above
 * the new one. Undefined otherwise, or without both points of the safe room.
 */
export function loweredLimit(
  points: readonly WindowPoint[],
  opts: { readonly untilMs: number; readonly stepMs: number; readonly roomId: string; readonly limitAt: (ms: number) => number },
): number | undefined {
  const tempAt = (ms: number) => points.find((p) => p.ms === ms)?.rooms.find((r) => r.id === opts.roomId)?.tempC;
  const beforeMs = opts.untilMs - opts.stepMs;
  const before = tempAt(beforeMs);
  const now = tempAt(opts.untilMs);
  if (before === undefined || now === undefined) return undefined;
  const limitBefore = opts.limitAt(beforeMs);
  const limitNow = opts.limitAt(opts.untilMs);
  return limitNow < limitBefore && before <= limitBefore && now > limitNow ? limitNow : undefined;
}

/** The zero-energy actions on the card: all of them against the heat, none when the room is heated. */
export function lastResortActions(season: Season): LastResortAction[] {
  return season === 'heating' ? [] : [...LAST_RESORT_ACTIONS];
}

/**
 * What ends a last resort's safe hours, in words. Temperature covers a room that feels hotter than its limit (the
 * heat index, #248); humidity ends them only where the plan dries the room under its minimum.
 */
export function lastResortThen(o: {
  limitedBy: 'battery' | 'temperature' | 'humidity';
  season: Season;
  /** The limit in force when the hours end. */
  limitThenC: number;
  /** What sets that limit (safeRoomLimitKindAt): a cap the person set is named as such (#266 review). */
  limitKind?: SafeRoomLimitKind;
  cooling: { maxC: number };
  heating: { minC: number };
  humidity: { minPct: number };
  /** The unit of the words (#306); °C when unset. */
  unit?: TempUnit;
}): string {
  const t = (c: number) => formatTemp(c, o.unit ?? 'C');
  if (o.limitedBy === 'battery') return 'the battery runs out';
  if (o.limitedBy === 'humidity') return `the humidity drops under its ${String(o.humidity.minPct)} % minimum`;
  if (o.season === 'heating') return `the room drops below its ${t(o.heating.minC)} minimum`;
  if (o.limitKind === 'older_person_cap') return `the room goes above ${t(o.limitThenC)}, the cap set for an older person`;
  if (o.limitKind === 'heat_index_cap') return `the room goes above, or feels hotter than, ${t(o.limitThenC)}, the heat-index cap set for this home`;
  return o.limitThenC < o.cooling.maxC
    ? `the room goes above, or feels hotter than, ${t(o.limitThenC)}, the night limit`
    : `the room goes above, or feels hotter than, its ${t(o.cooling.maxC)} maximum`;
}
