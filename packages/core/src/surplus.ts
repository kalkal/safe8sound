// Solar surplus at home instead of on the grid (#203): pure helpers for the planner. Where the projection of a
// plan exports (the battery cannot take more), and in which order the rooms get that energy: the safe room
// first (the person at risk), then the rooms that are or will be occupied, the hottest above target first.

export interface SurplusWindow {
  readonly fromMs: number;
  readonly toMs: number;
  /** Mean export over the window, in W: what the extra cooling may draw without importing. */
  readonly meanExportW: number;
  /** Energy the window sends to the grid, in Wh. */
  readonly exportWh: number;
}

/**
 * The first run of projection steps exporting at least `minExportW` with the battery at or above `minSocPct`.
 * Export alone is not a full battery: PV above the maximum charge exports even at 40 % (energy.ts), and cooling
 * then would take charge the night needs (#226 review).
 */
export function surplusWindow(
  points: readonly { readonly ms: number; readonly socPct: number; readonly flows: { readonly gridExportW: number } }[],
  opts: { readonly minExportW: number; readonly stepMs: number; readonly minSocPct?: number },
): SurplusWindow | undefined {
  const surplus = (p: (typeof points)[number]) => p.flows.gridExportW >= opts.minExportW && p.socPct >= (opts.minSocPct ?? 0);
  const start = points.findIndex(surplus);
  if (start < 0) return undefined;
  const after = points.slice(start).findIndex((p) => !surplus(p));
  const run = after < 0 ? points.slice(start) : points.slice(start, start + after);
  const first = run[0];
  const last = run.at(-1);
  if (first === undefined || last === undefined) return undefined;
  const totalW = run.reduce((w, p) => w + p.flows.gridExportW, 0);
  return { fromMs: first.ms, toMs: last.ms + opts.stepMs, meanExportW: totalW / run.length, exportWh: (totalW * opts.stepMs) / 3_600_000 };
}

export type SurplusReason = 'safe_room' | 'occupied' | 'occupied_tonight';

export interface SurplusRoom {
  readonly roomId: string;
  readonly reason: SurplusReason;
  /** How far the room is above its comfort target now, in K, one decimal (negative when below). */
  readonly aboveTargetK: number;
}

/**
 * The order the surplus goes in: the safe room always first, then the rooms occupied now, and the rooms slept in
 * when the window comes before the night (`tonight`), the hottest above target first; on a tie, the input
 * order (the person's room priority). Rooms nobody uses get nothing.
 */
export function orderSurplusRooms(
  rooms: readonly { readonly id: string; readonly tempC: number | undefined; readonly occupied: boolean; readonly isSafe: boolean; readonly sleptIn: boolean }[],
  opts: { readonly comfortC: number; readonly tonight: boolean },
): SurplusRoom[] {
  const above = (tempC: number) => Math.round((tempC - opts.comfortC) * 10) / 10;
  // A room with no reading gets nothing: how far above comfort it is would be made up (review of #303).
  const read = rooms.flatMap((r) => (r.tempC === undefined ? [] : [{ ...r, tempC: r.tempC }]));
  const safe = read.filter((r) => r.isSafe).map((r): SurplusRoom => ({ roomId: r.id, reason: 'safe_room', aboveTargetK: above(r.tempC) }));
  const others = read
    .filter((r) => !r.isSafe && (r.occupied || (opts.tonight && r.sleptIn)))
    .map((r): SurplusRoom => ({ roomId: r.id, reason: r.occupied ? 'occupied' : 'occupied_tonight', aboveTargetK: above(r.tempC) }));
  // A stable sort keeps the input order on a tie.
  return [...safe, ...others.sort((a, b) => b.aboveTargetK - a.aboveTargetK)];
}
