import type { Milestone } from '@cold-reserve/contracts';

// The judges' timeline of the day (brief 3b): the scenario's stops, the current one and the next one named. The sandbox
// lists only the moments ahead (get_milestones, #317/#391), so the page keeps every stop it has seen since the play of
// the day started and places the simulated time among them. No simulation logic here: only the order of instants.

const instant = (iso: string) => Date.parse(iso);

/**
 * The day's stops: those already passed (kept from what was seen, the server lists only what is ahead) and those ahead
 * as the latest list gives them, in time order. A stop the plan moved or dropped is never kept from an older list, so
 * the timeline never names a moment the clock would not go to (review of #450).
 */
export function addStops(seen: readonly Milestone[], ahead: readonly Milestone[], now: string): readonly Milestone[] {
  const passed = seen.filter((s) => instant(s.at) <= instant(now));
  const all = new Map<string, Milestone>();
  for (const s of [...passed, ...ahead]) all.set(`${s.kind}@${String(instant(s.at))}`, s);
  return [...all.values()].sort((a, b) => instant(a.at) - instant(b.at));
}

/** How many messages were sent after `from` and up to `to` (a jump of the clock): none when `from` is unknown. */
export function messagesBetween(messages: readonly { readonly at: string }[], from: string | undefined, to: string): number {
  if (from === undefined) return 0;
  return messages.filter((m) => instant(m.at) > instant(from) && instant(m.at) <= instant(to)).length;
}

export interface Timeline {
  readonly stops: readonly Milestone[];
  /** The last stop reached (at or before now), -1 before the first. */
  readonly current: number;
  readonly next?: Milestone;
}

export function timelineOf(stops: readonly Milestone[], now: string): Timeline {
  const t = instant(now);
  let current = -1;
  stops.forEach((s, i) => {
    if (instant(s.at) <= t) current = i;
  });
  const next = stops[current + 1];
  return next === undefined ? { stops, current } : { stops, current, next };
}
