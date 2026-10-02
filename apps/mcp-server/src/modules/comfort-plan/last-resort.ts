import { LAST_RESORT_ACTIONS, type LastResortAction, type Season } from '@cold-reserve/contracts';

// The honest window of a last resort (#160): the limit the safe room keeps from now until safeUntil, then how
// far it goes and by when, along the projection of the chosen plan.

interface WindowPoint {
  readonly ms: number;
  readonly rooms: readonly { readonly id: string; readonly tempC: number }[];
}

export interface WindowOptions {
  readonly nowMs: number;
  readonly untilMs: number;
  readonly roomId: string;
  readonly season: Season;
  /** The temperature limit in force at an instant: the cooling maximum (lowered at night) or the heating minimum. */
  readonly limitAt: (ms: number) => number;
  /**
   * Whether the sentence says the room stays inside the limit until safeUntil ("stays under 26 °C until …").
   * When the battery ends the safe hours it says "the battery lasts until …; the room then reaches …" instead.
   */
  readonly claimsUntil: boolean;
}

export interface LastResortWindow {
  readonly comfortLimitC: number;
  /** Rounded to one decimal, as it is said. */
  readonly worstC: number;
  readonly worstAtMs: number;
}

/**
 * The limit in force at safeUntil, then the warmest (the coldest when heating) point of the safe room from
 * there on, the earliest on a tie. Only a true sentence: undefined when it claims the room stays inside that
 * limit until safeUntil and the room is past it anywhere from now on (the grace period, a lower night limit),
 * when the room never goes past it afterwards, or when the projection has no such point.
 */
export function lastResortWindow(points: readonly WindowPoint[], opts: WindowOptions): LastResortWindow | undefined {
  const heating = opts.season === 'heating';
  const comfortLimitC = opts.limitAt(opts.untilMs);
  const past = (tempC: number) => (heating ? tempC < comfortLimitC : tempC > comfortLimitC);
  let worst: { tempC: number; ms: number } | undefined;
  for (const p of points) {
    if (p.ms < opts.nowMs) continue;
    const room = p.rooms.find((r) => r.id === opts.roomId);
    if (room === undefined) continue;
    if (p.ms < opts.untilMs) {
      if (opts.claimsUntil && past(room.tempC)) return undefined;
      continue;
    }
    const worse = worst === undefined || (heating ? room.tempC < worst.tempC : room.tempC > worst.tempC);
    if (worse) worst = { tempC: room.tempC, ms: p.ms };
  }
  if (worst === undefined) return undefined;
  const worstC = Math.round(worst.tempC * 10) / 10;
  return past(worstC) ? { comfortLimitC, worstC, worstAtMs: worst.ms } : undefined;
}

/** The zero-energy actions on the card: all of them against the heat, none when the room is heated. */
export function lastResortActions(season: Season): LastResortAction[] {
  return season === 'heating' ? [] : [...LAST_RESORT_ACTIONS];
}
