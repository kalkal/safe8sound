import {
  celsius,
  epochMs,
  minutes,
  ok,
  pct,
  watt,
  type ErrorEnvelope,
  type Forecast,
  type HomeProfile,
  type Result,
  type RoomReading,
  type Snapshot,
} from '@cold-reserve/contracts';
import { resolveOrigin, rngAt, stepHome, type Clock, type HomeDataSource, type HomeState, type SimParams } from '@cold-reserve/core';
import { inputsAt, type Scenario } from './scenario.js';

export interface SimulatorSourceOptions {
  readonly profile: HomeProfile;
  readonly scenario: Scenario;
  readonly params: SimParams;
  /** Scenario time (see `scenarioClock` in core), never the time of day. */
  readonly clock: Clock;
}

const HOUR_MS = 3_600_000;
const round = (x: number, digits = 0) => Math.round(x * 10 ** digits) / 10 ** digits + 0;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * HomeDataSource from the seeded simulator. The state at a given second is a pure function of the
 * scenario (seed included) and that second: reproducible whatever was asked before. Readings outside
 * the scenario window are clamped to its start or end. Every group is simulated, with the scenario name.
 */
export class SimulatorSource implements HomeDataSource {
  readonly #opts: SimulatorSourceOptions;
  readonly #startMs: number;
  readonly #endS: number;
  /** State at each step boundary, computed on demand; deterministic, so caching changes nothing. */
  readonly #states: HomeState[];

  constructor(opts: SimulatorSourceOptions) {
    this.#opts = opts;
    this.#startMs = epochMs(opts.scenario.startAt);
    this.#endS = opts.scenario.durationH * 3600;
    this.#states = [{ socPct: opts.scenario.initial.batterySocPct, rooms: opts.scenario.initial.rooms }];
  }

  snapshot(): Promise<Result<Snapshot, ErrorEnvelope>> {
    return Promise.resolve(ok(this.snapshotAt(this.#opts.clock.now())));
  }

  snapshotAt(ms: number): Snapshot {
    const { profile, scenario, params } = this.#opts;
    const elapsedS = this.#elapsedS(ms);
    const state = this.#stateAt(elapsedS);
    const inputs = inputsAt(scenario, elapsedS);
    // Instantaneous flows: the step that starts now.
    const { flows } = stepHome({
      state,
      inputs,
      profile,
      params,
      dt: minutes(scenario.stepSeconds / 60),
      noise: rngAt(scenario.seed, Math.floor(elapsedS / scenario.stepSeconds)),
    });

    const rooms = state.rooms.map((r): RoomReading => {
      const input = inputs.rooms.find((i) => i.id === r.id);
      return {
        id: r.id,
        tempC: celsius(round(r.tempC, 1)),
        humidityPct: pct(round(r.humidityPct)),
        occupants: [...(input?.occupants ?? [])],
        ...(input?.hvac === undefined ? {} : { hvac: { mode: input.hvac.mode, setpointC: input.hvac.setpointC } }),
        fanOn: input?.fanOn ?? false,
      };
    });

    return {
      schemaVersion: 1,
      homeId: profile.homeId,
      ts: iso(this.#startMs + elapsedS * 1000),
      pvW: watt(round(flows.pvUsedW)),
      loadW: watt(round(flows.servedLoadW)),
      batterySocPct: pct(round(state.socPct, 1)),
      gridW: watt(round(flows.gridW)),
      gridAvailable: inputs.gridAvailable,
      rooms,
      origin: resolveOrigin([], { id: scenario.id, simulatedGroups: scenario.simulatedGroups }),
      homeLink: 'ok',
    };
  }

  /** The scenario weather from the next whole hour to the end: known in advance, so confidence is high. */
  forecast(): Forecast {
    const { scenario } = this.#opts;
    const nowMs = this.#opts.clock.now();
    const first = Math.min(scenario.durationH, Math.max(0, Math.ceil((nowMs - this.#startMs) / HOUR_MS)));
    return {
      fetchedAt: iso(this.#startMs + this.#elapsedS(nowMs) * 1000),
      confidence: 'high',
      confidenceReason: 'Scenario weather (simulated), known in advance.',
      hourly: scenario.hourly.slice(first).map((h, i) => ({
        ts: iso(this.#startMs + (first + i) * HOUR_MS),
        tempOutC: h.tempOutC,
        humidityOutPct: h.humidityOutPct,
        irradianceWm2: h.irradianceWm2,
        stormProb: h.stormProb,
      })),
      sunrise: [...scenario.sun.sunrise],
      sunset: [...scenario.sun.sunset],
    };
  }

  /** Whole seconds since the scenario start, clamped to the scenario window. */
  #elapsedS(ms: number): number {
    return Math.min(this.#endS, Math.max(0, Math.floor((ms - this.#startMs) / 1000)));
  }

  #stateAt(elapsedS: number): HomeState {
    const { profile, scenario, params } = this.#opts;
    const step = scenario.stepSeconds;
    const advance = (state: HomeState, fromS: number, seconds: number, index: number) =>
      stepHome({ state, inputs: inputsAt(scenario, fromS), profile, params, dt: minutes(seconds / 60), noise: rngAt(scenario.seed, index) }).state;

    const k = Math.floor(elapsedS / step);
    for (let j = this.#states.length - 1; j < k; j++) {
      this.#states.push(advance(this.#boundary(j), j * step, step, j));
    }
    const rest = elapsedS - k * step;
    return rest === 0 ? this.#boundary(k) : advance(this.#boundary(k), k * step, rest, k);
  }

  #boundary(k: number): HomeState {
    const s = this.#states[k];
    if (s === undefined) throw new Error(`Simulator state ${k} was not computed`);
    return s;
  }
}
