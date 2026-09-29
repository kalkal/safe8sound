import { celsius, pct, type Counterfactual, type CounterfactualLine } from '@cold-reserve/contracts';
import { lineMetrics, naiveControls, noPlanControls, type ProjectionPoint } from '@cold-reserve/core';
import { buildContext, currentControls, projectFrom, type GuardInput } from './context.js';

// Counterfactual "without us" (feature queue item 2): the same snapshot, forecast and horizon as the
// guard's projection of the plan, with (a) nothing running and (b) the naive plan "AC until the battery
// dies": the settings running now, kept as they are (or, when nothing runs, the comfort setpoint in the
// safe and occupied rooms), with no pacing and no reserve. Measured in the safe room exactly like the plan.

const round1 = (x: number) => Math.round(x * 10) / 10 + 0;
const round2 = (x: number) => Math.round(x * 100) / 100 + 0;

export function counterfactualOf(input: GuardInput): Counterfactual | undefined {
  const ctx = buildContext(input);
  const { profile, preferences, snapshot, config } = input;
  const hardwareFloor = pct(profile.battery.minSocHwPct);
  const opts = { toMs: ctx.horizonMs, dischargeFloorPct: hardwareFloor };
  const noPlan = projectFrom(input, () => noPlanControls(profile), opts);
  const running = currentControls(snapshot).filter((c) => c.hvac !== undefined && c.hvac.mode !== 'off');
  const occupied = snapshot.rooms.filter((r) => r.occupants.length > 0).map((r) => r.id);
  const naiveNow =
    running.length > 0
      ? currentControls(snapshot)
      : naiveControls(profile, { occupied, safeRoomId: preferences.safeRoomId, setpointC: preferences.comfortC.cooling });
  const naive = projectFrom(input, () => naiveNow, opts);

  const line = (points: readonly ProjectionPoint[]): CounterfactualLine | undefined => {
    const m = lineMetrics(points, {
      roomId: preferences.safeRoomId,
      tz: profile.location.tz,
      stepMinutes: config.projection.stepMinutes,
      thresholdC: config.nightRecovery.thresholdC[input.nightRecoveryMode],
      config: config.nightRecovery,
    });
    return m === undefined
      ? undefined
      : {
          peakTempC: celsius(round1(m.peakTempC)),
          peakAt: new Date(m.peakAtMs).toISOString(),
          heatIndexDegreeHours: round2(m.heatIndexDegreeHours),
          hoursAtOrBelowThreshold: round2(m.hoursAtOrBelowThreshold),
        };
  };
  const lines = { noPlan: line(noPlan), naive: line(naive), plan: line(ctx.points) };
  if (lines.noPlan === undefined || lines.naive === undefined || lines.plan === undefined) return undefined;
  return { roomId: preferences.safeRoomId, scenarios: { noPlan: lines.noPlan, naive: lines.naive, plan: lines.plan } };
}
