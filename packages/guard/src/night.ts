import { celsius, type NightRecovery, type PlanWarning } from '@cold-reserve/contracts';
import { nightMetrics, type NightMetrics, type ProjectionPoint, type RoomControl } from '@cold-reserve/core';
import { UNSERVED_TOLERANCE_W, projectFrom, type GuardContext } from './context.js';

// Night recovery (feature queue item 1; definitions and sources in packages/contracts/src/night-recovery.ts
// and packages/core/src/night.ts). The status is honest by construction:
// - met: the plan's own projection reaches the hours and stays within the heat budget;
// - unmet: it does not, but a reference strategy does without running the battery out before the next
//   recharge and with the room's humidity inside its safety band all night, so the target is feasible and
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
  const meets = (m: NightMetrics | undefined) =>
    m !== undefined && m.achievedHours >= requiredHours - EPS && m.heatIndexDegreeHours <= cfg.budgetDegreeHours + EPS;

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

  const referencePoints = projectFrom(input, referenceControl(ctx, plan.window.startMs, thresholdC - cfg.referenceSetpointMarginK), {
    toMs: ctx.horizonMs,
    dischargeFloorPct: ctx.dischargeFloorPct,
  });
  const sustainable = ctx.gridAvailable || !referencePoints.some((p) => p.flows.unservedLoadW > UNSERVED_TOLERANCE_W);
  const { humidity } = input.preferences.safety;
  const windowEndMs = plan.window.endMs;
  const safe = referencePoints
    .filter((p) => p.ms >= plan.window.startMs && p.ms < windowEndMs)
    .flatMap((p) => p.rooms.filter((r) => r.id === roomId))
    .every((r) => r.humidityPct >= humidity.minPct && r.humidityPct <= humidity.maxPct);
  const reference = sustainable && safe ? measure(referencePoints) : undefined;
  if (meets(reference)) return { nightRecovery: { ...base, status: 'unmet' }, warnings: [] };

  const best = round2(Math.max(plan.achievedHours, reference?.achievedHours ?? 0));
  const room = input.profile.rooms.find((r) => r.id === roomId)?.name ?? roomId;
  return {
    nightRecovery: { ...base, status: 'infeasible', bestAchievableHours: best },
    warnings: [
      {
        code: 'night_recovery_infeasible',
        // With the grid up the limit is the air conditioner (or the room's humidity), not the battery.
        message: `Tonight ${ctx.gridAvailable ? 'the air conditioner' : 'the battery'} can keep the ${room} at or below ${thresholdC.toString()} °C for about ${best.toString()} hours, not the ${base.requiredHours.toString()} hours of the night-recovery target.`.slice(0, 300),
      },
    ],
  };
}

/** Length of the night window in hours (22 → 7 is 9 hours). */
export const nightWindowHours = (startHour: number, endHour: number): number => (endHour - startHour + 24) % 24;

/** Safe room only, off until the night window, then cooling (or drying) below the threshold. */
function referenceControl(ctx: GuardContext, windowStartMs: number, setpointC: number): (ms: number) => RoomControl[] {
  const { profile, preferences } = ctx.input;
  const safe = profile.rooms.find((r) => r.id === preferences.safeRoomId);
  const modes = safe?.hvacUnits.flatMap((u) => u.modes) ?? [];
  const mode = modes.includes('cool') ? 'cool' : modes.includes('dry') ? 'dry' : undefined;
  return (ms) =>
    profile.rooms.map((r): RoomControl =>
      r.id === preferences.safeRoomId && mode !== undefined && ms >= windowStartMs
        ? { id: r.id, hvac: { mode, setpointC: celsius(setpointC) }, fanOn: false }
        : { id: r.id, fanOn: false },
    );
}
