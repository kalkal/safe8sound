import { celsius, type HomeProfile, type NightRecovery, type PlanWarning } from '@cold-reserve/contracts';
import { degreeHours, heatAmount, temp } from './display.js';
import { nightMetrics, type NightMetrics, type ProjectionPoint, type RoomControl } from '@cold-reserve/core';
import { UNSERVED_TOLERANCE_W, projectFrom, type GuardContext } from './context.js';

// Night recovery (feature queue item 1; definitions and sources in packages/contracts/src/night-recovery.ts
// and packages/core/src/night.ts). The status is honest by construction:
// - met: the plan's own projection reaches the hours and stays within the heat budget;
// - unmet: it does not, but a reference strategy does without running the battery out before the next
//   recharge and without drying the room under its humidity minimum, so the target is feasible and
//   the plan is rejected;
// - infeasible: no such strategy was found; the plan is not rejected, a warning says so with the best hours.
// The reference spends the battery on the safe room only, and only during the night window, cooling a
// little below the threshold. It is a feasibility witness, not an optimiser. Hours that would leave the
// safe room without power before dawn are not "achievable": off grid, a reference that runs the battery
// out does not count, and the best hours reported are then the plan's own.

const EPS = 1e-9;
const round2 = (x: number) => Math.round(x * 100) / 100 + 0;

export function evaluateNight(ctx: GuardContext): { nightRecovery?: NightRecovery; warnings: PlanWarning[] } {
  const { input } = ctx;
  if (input.season !== 'cooling') return { warnings: [] };
  const cfg = input.config.nightRecovery;
  const roomId = input.preferences.safeRoomId;
  const thresholdC = cfg.thresholdC[input.nightRecoveryMode];
  const measure = (points: readonly ProjectionPoint[]) =>
    nightMetrics(points, { roomId, tz: input.profile.location.tz, stepMinutes: input.config.projection.stepMinutes, thresholdC, config: cfg });

  const plan = measure(ctx.points);
  if (plan === undefined) return { warnings: [] };
  // A partial window (a re-plan at 02:00, or a horizon that ends before 07:00) cannot see the hours outside
  // it: those are given the benefit of the doubt, so only the hours still needed are required.
  const windowHours = nightWindowHours(cfg.windowStartHour, cfg.windowEndHour);
  // Clamped: on the autumn clock change the night lasts 10 hours, one more than the window's 9.
  const requiredHours = Math.min(cfg.requiredHours, Math.max(0, cfg.requiredHours - (windowHours - plan.coveredHours)));
  const meets = (m: NightMetrics | undefined) => nightMeets(m, requiredHours, cfg.budgetDegreeHours);

  const base = {
    roomId,
    mode: input.nightRecoveryMode,
    thresholdC: celsius(thresholdC),
    window: { start: new Date(plan.window.startMs).toISOString(), end: new Date(plan.window.endMs).toISOString() },
    requiredHours: round2(requiredHours),
    achievedHours: round2(plan.achievedHours),
    heatIndexDegreeHoursAbove26_7: round2(plan.heatIndexDegreeHours),
    budgetDegreeHours: cfg.budgetDegreeHours,
  };
  if (meets(plan)) return { nightRecovery: { ...base, status: 'met' }, warnings: [] };

  const referencePoints = projectFrom(input, referenceControl(input.profile, roomId, plan.window.startMs, thresholdC - cfg.referenceSetpointMarginK), {
    toMs: ctx.horizonMs,
    dischargeFloorPct: ctx.dischargeFloorPct,
  });
  const proven = referenceProves(referencePoints, {
    gridAvailable: ctx.gridAvailable,
    window: plan.window,
    roomId,
    band: input.preferences.safety.humidity,
    dries: referenceDries(input.profile, roomId),
  });
  const reference = proven ? measure(referencePoints) : undefined;
  if (meets(reference)) return { nightRecovery: { ...base, status: 'unmet' }, warnings: [] };

  const best = round2(Math.max(plan.achievedHours, reference?.achievedHours ?? 0));
  const room = input.profile.rooms.find((r) => r.id === roomId)?.name ?? roomId;
  const limit = ctx.gridAvailable ? 'the air conditioner' : 'the battery';
  const unit = input.displayUnit ?? 'C';
  return {
    nightRecovery: { ...base, status: 'infeasible', bestAchievableHours: best },
    warnings: [
      {
        code: 'night_recovery_infeasible',
        // With the grid up the limit is the air conditioner (or the room's humidity), not the battery. When the
        // hours are reached, what cannot be kept is the heat budget: say that, not "x hours, not the 0".
        message: (plan.achievedHours >= requiredHours - EPS
          ? `Tonight ${limit} cannot keep the heat in the ${room} within the night budget: about ${heatAmount(base.heatIndexDegreeHoursAbove26_7, unit)}, over the ${degreeHours(cfg.budgetDegreeHours, unit)} allowed.`
          : `Tonight ${limit} can keep the ${room} at or below ${temp(thresholdC, unit)} for about ${best.toString()} hours, not the ${base.requiredHours.toString()} hours of the night-recovery target.`
        ).slice(0, 300),
      },
    ],
  };
}

/** Length of the night window in hours (22 → 7 is 9 hours). */
export const nightWindowHours = (startHour: number, endHour: number): number => (endHour - startHour + 24) % 24;

/** A night counts as met with the required hours at or below the threshold and the heat within the budget. */
export function nightMeets(m: Pick<NightMetrics, 'achievedHours' | 'heatIndexDegreeHours'> | undefined, requiredHours: number, budgetDegreeHours: number): boolean {
  return m !== undefined && m.achievedHours >= requiredHours - EPS && m.heatIndexDegreeHours <= budgetDegreeHours + EPS;
}

/**
 * Whether the reference strategy proves anything: it must be sustainable (off grid, the battery must not run
 * out, so no load is left unserved) and keep the safe room inside its humidity band through the window.
 */
export function referenceProves(
  points: readonly ProjectionPoint[],
  opts: { gridAvailable: boolean; window: { startMs: number; endMs: number }; roomId: string; band: { minPct: number }; dries: boolean },
): boolean {
  const sustainable = opts.gridAvailable || !points.some((p) => p.flows.unservedLoadW > UNSERVED_TOLERANCE_W);
  const aboveMinimum = points
    .filter((p) => p.ms >= opts.window.startMs && p.ms < opts.window.endMs)
    .flatMap((p) => p.rooms.filter((r) => r.id === opts.roomId))
    // Under the minimum counts only when the reference dries the room: cooling cannot raise the humidity (#107).
    // Humid air is not a limit (#248): the heat it adds is in the heat-index budget.
    .every((r) => !opts.dries || r.humidityPct >= opts.band.minPct);
  return sustainable && aboveMinimum;
}

/** The reference dries only when the safe room's unit cannot cool. */
export function referenceDries(profile: HomeProfile, safeRoomId: string): boolean {
  const modes = profile.rooms.find((r) => r.id === safeRoomId)?.hvacUnits.flatMap((u) => u.modes) ?? [];
  return !modes.includes('cool') && modes.includes('dry');
}

/** Safe room only, off until the night window, then cooling (or drying) below the threshold. */
export function referenceControl(profile: HomeProfile, safeRoomId: string, windowStartMs: number, setpointC: number): (ms: number) => RoomControl[] {
  const safe = profile.rooms.find((r) => r.id === safeRoomId);
  const modes = safe?.hvacUnits.flatMap((u) => u.modes) ?? [];
  const mode = modes.includes('cool') ? 'cool' : modes.includes('dry') ? 'dry' : undefined;
  return (ms) =>
    profile.rooms.map((r): RoomControl =>
      r.id === safeRoomId && mode !== undefined && ms >= windowStartMs
        ? { id: r.id, hvac: { mode, setpointC: celsius(setpointC) }, fanOn: false }
        : { id: r.id, fanOn: false },
    );
}
