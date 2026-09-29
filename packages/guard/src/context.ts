import {
  pct,
  type Forecast,
  type HomeProfile,
  type NightRecoveryMode,
  type Pct,
  type Plan,
  type Preferences,
  type Season,
  type Snapshot,
} from '@cold-reserve/contracts';
import {
  acLimitW,
  controlFromSteps,
  darkWindow,
  indoorEquilibriumRh,
  localHour,
  project,
  reserveFloorSocPct,
  reserveWh,
  weatherFromForecast,
  type ProjectionPoint,
  type RoomControl,
  type SimParams,
} from '@cold-reserve/core';
import type { GuardConfig } from './config.js';

// The guard's inputs and the context every constraint reads: the plan projected from the snapshot with
// the simulator physics, the reserve floor and the limits. Computed once per check.

/** What the guard needs of a plan: the parts the planner decides. */
export type CandidatePlan = Pick<Plan, 'horizonAt' | 'steps' | 'ladder'>;

export interface GuardInput {
  readonly plan: CandidatePlan;
  readonly snapshot: Snapshot;
  readonly forecast: Forecast;
  readonly profile: HomeProfile;
  readonly preferences: Preferences;
  readonly season: Season;
  /** Physics of the projection (the simulator parameters, from config). */
  readonly model: SimParams;
  readonly config: GuardConfig;
  readonly nightRecoveryMode: NightRecoveryMode;
}

/** Everything the constraints read, computed once. */
export interface GuardContext {
  readonly input: GuardInput;
  readonly nowMs: number;
  /** The plan horizon, extended to the next recharge when the forecast shows it (a plan cannot cheat pacing). */
  readonly horizonMs: number;
  readonly gridAvailable: boolean;
  readonly reserveWh: number;
  readonly reserveFloorSocPct: Pct;
  /** Where the projected battery stops: the reserve floor on grid, the hardware floor off grid. */
  readonly dischargeFloorPct: Pct;
  readonly acLimitW: number;
  readonly points: readonly ProjectionPoint[];
  /** The plan's battery targets, sorted by time (the lowest when several share a time). */
  readonly targets: readonly { readonly ms: number; readonly pct: number }[];
}

/**
 * Load left unserved above this is a real shortfall (the battery is empty or cannot deliver); below it is
 * rounding noise of the dispatch.
 */
export const UNSERVED_TOLERANCE_W = 1;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export function buildContext(input: GuardInput): GuardContext {
  const { snapshot, profile, config, plan } = input;
  const nowMs = Date.parse(snapshot.ts);
  const dark = darkWindow({
    forecast: input.forecast,
    fromMs: nowMs,
    pvPeakW: profile.pvPeakW,
    lossRatio: input.model.pv.lossRatio,
    essentialLoadW: config.reserve.essentialLoadW,
  });
  // No recharge in sight: the prudent answer is the whole cap.
  const reserve =
    dark === undefined
      ? config.reserve.capWh
      : reserveWh({
          essentialLoadW: config.reserve.essentialLoadW,
          darkHours: (dark.toMs - dark.fromMs) / HOUR_MS,
          roundTripEff: profile.battery.roundTripEff,
          capWh: config.reserve.capWh,
        });
  const floor = reserveFloorSocPct(profile.battery, reserve);
  const stepMs = config.projection.stepMinutes * MINUTE_MS;
  const horizonMs = Math.max(Date.parse(plan.horizonAt), dark?.toMs ?? 0, nowMs + stepMs);
  const dischargeFloorPct = snapshot.gridAvailable ? floor : pct(profile.battery.minSocHwPct);

  return {
    input,
    nowMs,
    horizonMs,
    gridAvailable: snapshot.gridAvailable,
    reserveWh: reserve,
    reserveFloorSocPct: floor,
    dischargeFloorPct,
    acLimitW: acLimitW(profile, snapshot.gridAvailable),
    points: projectFrom(input, controlFromSteps(plan.steps, currentControls(snapshot)), { toMs: horizonMs, dischargeFloorPct }),
    targets: targetsOf(plan),
  };
}

/** The room settings the snapshot reports: what happens before a plan's first step. */
export function currentControls(snapshot: Snapshot): RoomControl[] {
  return snapshot.rooms.map((r) => ({ id: r.id, ...(r.hvac === undefined ? {} : { hvac: { mode: r.hvac.mode, setpointC: r.hvac.setpointC } }), fanOn: r.fanOn ?? false }));
}

/** Projects any control schedule from the snapshot: the plan, or the night-recovery reference. */
export function projectFrom(
  input: GuardInput,
  controlAt: (ms: number) => readonly RoomControl[],
  opts: { toMs: number; dischargeFloorPct: Pct },
): ProjectionPoint[] {
  const { snapshot, profile } = input;
  const nowMs = Date.parse(snapshot.ts);
  const weatherAt = weatherFromForecast(input.forecast);
  const now = weatherAt(nowMs);
  const known = snapshot.rooms.filter((r) => profile.rooms.some((p) => p.id === r.id));
  return project({
    profile,
    params: input.model,
    start: {
      ms: nowMs,
      socPct: snapshot.batterySocPct,
      rooms: known.map((r) => ({
        id: r.id,
        tempC: r.tempC,
        humidityPct: r.humidityPct ?? indoorEquilibriumRh({ outC: now.outC, outRhPct: now.outRhPct, inC: r.tempC }),
      })),
      occupants: Object.fromEntries(known.map((r) => [r.id, r.occupants])),
    },
    weatherAt,
    controlAt: (ms) => controlAt(ms).filter((c) => known.some((r) => r.id === c.id)),
    gridAvailable: snapshot.gridAvailable,
    dischargeFloorPct: opts.dischargeFloorPct,
    baseLoadAt: (ms) => {
      const byHour = input.config.projection.baseLoadWByLocalHour;
      return byHour[Math.floor(localHour(ms, profile.location.tz)) % 24] ?? 0;
    },
    toMs: opts.toMs,
    stepMinutes: input.config.projection.stepMinutes,
  });
}

function targetsOf(plan: CandidatePlan): { ms: number; pct: number }[] {
  const byTime = new Map<number, number>();
  for (const s of plan.steps) {
    const ms = Date.parse(s.ts);
    byTime.set(ms, Math.min(byTime.get(ms) ?? Infinity, s.batteryTargetSocPct));
  }
  return [...byTime.entries()].map(([ms, p]) => ({ ms, pct: p })).sort((a, b) => a.ms - b.ms);
}
