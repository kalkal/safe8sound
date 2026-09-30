import { epochMs, type Level, type Plan } from '@cold-reserve/contracts';

// Pure view models of a plan: no React, no I/O, unit tested.

const clocks = new Map<string, Intl.DateTimeFormat>();

/** "hh:mm" on the home's clock (IANA zone from the home profile), whatever offset the timestamp carries. */
export function homeClock(isoTs: string, timeZone: string): string {
  let clock = clocks.get(timeZone);
  if (clock === undefined) {
    clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
    clocks.set(timeZone, clock);
  }
  return clock.format(new Date(isoTs));
}

export interface LevelSpan {
  level: Level;
  /** First span of this level in the plan, or null when the plan never needs it. */
  from: string | null;
  to: string | null;
  current: boolean;
}

/** The level ribbon: every rung of the confirmed ladder, with the first time span it is used. */
export function levelSpans(plan: Plan, timeZone: string): LevelSpan[] {
  const steps = [...plan.steps].sort((a, b) => epochMs(a.ts) - epochMs(b.ts));
  const spans = new Map<Level, { from: string; to: string }>();
  steps.forEach((step, i) => {
    if (i > 0 && steps[i - 1]?.level === step.level) return;
    if (spans.has(step.level)) return;
    const next = steps.slice(i + 1).find((s) => s.level !== step.level);
    spans.set(step.level, { from: homeClock(step.ts, timeZone), to: homeClock(next?.ts ?? plan.horizonAt, timeZone) });
  });
  const current = steps[0]?.level;
  return plan.ladder.map(({ level }) => {
    const span = spans.get(level);
    return { level, from: span?.from ?? null, to: span?.to ?? null, current: level === current };
  });
}

export interface PacingGeometry {
  /** x: 0–100 from plan creation to the horizon; y: 100 − expected charge in %. */
  points: Array<{ x: number; y: number }>;
  /** The storm reserve floor in SOC %: the guard's floor from the plan, else computed from the battery size. */
  floorPct?: number;
}

export function pacingGeometry(plan: Plan, batteryUsableWh?: number): PacingGeometry {
  const start = epochMs(plan.createdAt);
  const span = epochMs(plan.horizonAt) - start;
  const points = [...plan.steps]
    .sort((a, b) => epochMs(a.ts) - epochMs(b.ts))
    // A plan whose horizon is its creation time has no time axis: every point sits at the end.
    .map((s) => ({ x: span > 0 ? Math.min(100, ((epochMs(s.ts) - start) / span) * 100) : 100, y: 100 - s.batteryTargetSocPct }));
  // With the grid down the reserve is the budget, not a floor (#90).
  if (plan.gridAvailable === false) return { points };
  if (plan.reserveFloorSocPct !== undefined) return { points, floorPct: Math.round(plan.reserveFloorSocPct) };
  if (batteryUsableWh === undefined || batteryUsableWh <= 0) return { points };
  return { points, floorPct: Math.round((plan.reserveWh / batteryUsableWh) * 100) };
}

/** True when any group of the plan's inputs is simulated: the plan is then never shown as live. */
export const isSimulated = (plan: Plan): boolean => Object.values(plan.sourceOrigin).includes('simulated');
