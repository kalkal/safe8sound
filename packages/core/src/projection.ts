import { celsius, minutes, pct, watt, type Celsius, type Forecast, type HomeProfile, type HvacMode, type Pct, type PlanStep } from '@cold-reserve/contracts';
import { withDischargeFloor } from './reserve.js';
import { stepHome, type HomeFlows, type RoomState, type SimParams } from './simulation.js';

// Projection of a plan (or of a counterfactual) over the coming hours with the same physics as the
// simulator (plan §9.1: one core for simulator, guard and planner). Deterministic: the load noise is
// taken at its mean, the grid stays as it is now (a storm is assumed to last the whole projection, the
// prudent choice of plan §4bis.1), and the weather comes from the forecast.

export interface RoomControl {
  readonly id: string;
  readonly hvac?: { readonly mode: HvacMode; readonly setpointC: Celsius };
  readonly fanOn: boolean;
}

export interface Weather {
  readonly outC: Celsius;
  readonly outRhPct: Pct;
  readonly irradianceWm2: number;
}

export interface ProjectionInput {
  readonly profile: HomeProfile;
  readonly params: SimParams;
  readonly start: {
    readonly ms: number;
    readonly socPct: Pct;
    readonly rooms: readonly RoomState[];
    /** Occupants per room id, held for the whole projection. */
    readonly occupants: Readonly<Record<string, readonly string[]>>;
  };
  readonly weatherAt: (ms: number) => Weather;
  /** The room settings at an instant; it gets the room states at that instant, so a controller can react to them. */
  readonly controlAt: (ms: number, rooms: readonly RoomState[]) => readonly RoomControl[];
  readonly gridAvailable: boolean;
  /** The battery stops discharging here (the reserve floor on grid, the hardware floor off grid). */
  readonly dischargeFloorPct: Pct;
  /** Base load (everything but HVAC and fans) at an instant, W. */
  readonly baseLoadAt: (ms: number) => number;
  /** End of the projection (exclusive). */
  readonly toMs: number;
  readonly stepMinutes: number;
}

/** The state at the start of a step and the flows during it. */
export interface ProjectionPoint {
  readonly ms: number;
  readonly socPct: Pct;
  readonly rooms: readonly RoomState[];
  readonly flows: HomeFlows;
}

const MINUTE_MS = 60_000;
const MEAN_NOISE = 0.5;

export function project(input: ProjectionInput): ProjectionPoint[] {
  const { profile, params } = input;
  const floored = { ...profile, battery: withDischargeFloor(profile.battery, input.dischargeFloorPct) };
  const dt = minutes(input.stepMinutes);
  const stepMs = input.stepMinutes * MINUTE_MS;
  const points: ProjectionPoint[] = [];
  let state = { socPct: input.start.socPct, rooms: input.start.rooms };
  for (let ms = input.start.ms; ms < input.toMs; ms += stepMs) {
    const weather = input.weatherAt(ms);
    const rooms = input.controlAt(ms, state.rooms).map((c) => ({
      id: c.id,
      occupants: input.start.occupants[c.id] ?? [],
      ...(c.hvac === undefined ? {} : { hvac: c.hvac }),
      fanOn: c.fanOn,
    }));
    const next = stepHome({
      state,
      inputs: { ...weather, baseLoadW: watt(input.baseLoadAt(ms)), gridAvailable: input.gridAvailable, rooms },
      profile: floored,
      params,
      dt,
      noise: MEAN_NOISE,
    });
    points.push({ ms, socPct: state.socPct, rooms: state.rooms, flows: next.flows });
    state = next.state;
  }
  return points;
}

/** Forecast weather at any instant: linear between hours, held before the first and after the last. */
export function weatherFromForecast(forecast: Forecast): (ms: number) => Weather {
  const hours = forecast.hourly.map((h) => ({ ...h, ms: Date.parse(h.ts) })).sort((a, b) => a.ms - b.ms);
  return (ms) => {
    const i = hours.findIndex((h) => h.ms > ms);
    const after = hours[i];
    const before = i === -1 ? hours.at(-1) : hours[i - 1];
    if (before === undefined || after === undefined) {
      const h = before ?? after;
      if (h === undefined) throw new Error('The forecast has no hours');
      return { outC: h.tempOutC, outRhPct: h.humidityOutPct, irradianceWm2: h.irradianceWm2 };
    }
    const f = (ms - before.ms) / (after.ms - before.ms);
    const mix = (a: number, b: number) => a + (b - a) * f;
    return {
      outC: celsius(mix(before.tempOutC, after.tempOutC)),
      outRhPct: pct(mix(before.humidityOutPct, after.humidityOutPct)),
      irradianceWm2: mix(before.irradianceWm2, after.irradianceWm2),
    };
  };
}

/**
 * Room controls over time from plan steps: for each room the latest step at or before the instant,
 * and the room's `current` settings before its first step. Rooms only in the steps are added.
 */
export function controlFromSteps(steps: readonly PlanStep[], current: readonly RoomControl[]): (ms: number) => RoomControl[] {
  const byRoom = new Map<string, { ms: number; control: RoomControl }[]>();
  for (const s of steps) {
    const control: RoomControl = { id: s.roomId, hvac: { mode: s.hvacMode, setpointC: s.setpointC }, fanOn: s.fanOn };
    byRoom.set(s.roomId, [...(byRoom.get(s.roomId) ?? []), { ms: Date.parse(s.ts), control }]);
  }
  for (const list of byRoom.values()) list.sort((a, b) => a.ms - b.ms);
  const ids = [...new Set([...current.map((c) => c.id), ...byRoom.keys()])];
  return (ms) =>
    ids.map((id) => {
      const applied = (byRoom.get(id) ?? []).filter((s) => s.ms <= ms).at(-1);
      return applied?.control ?? current.find((c) => c.id === id) ?? { id, fanOn: false };
    });
}
