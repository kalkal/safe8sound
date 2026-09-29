import { watt, type Celsius, type HomeProfile, type HvacMode, type Minutes, type Pct, type Watt } from '@cold-reserve/contracts';
import { acLimitW, dispatch, type Dispatch } from './energy.js';
import { hvacResponse, type HvacModelParams, type HvacResponse } from './hvac.js';
import { indoorEquilibriumRh, stepRoomHumidity } from './humidity.js';
import { pvPowerW } from './pv.js';
import { coolingToReachW, stepRoomTemperature } from './thermal.js';

// One step of the whole simulated home: rooms (1R1C + humidity), HVAC, fans, base load, PV, battery.
// Pure: the caller passes the noise draw and the step length; every physical parameter comes from
// the home profile or from `SimParams` (config), never from constants here.

export interface SimParams {
  readonly hvac: HvacModelParams;
  /** Internal heat gains per room, W. */
  readonly gains: { readonly perRoomBaseW: number; readonly perOccupantW: number };
  /** Effective solar aperture (window area x solar gain factor), m², per room with a default. */
  readonly solarApertureM2: { readonly default: number; readonly byRoom: Readonly<Record<string, number>> };
  readonly humidity: { readonly exchangeTimeConstantH: number; readonly coolRemovalPctPerH: number; readonly dryRemovalPctPerH: number };
  readonly pv: { readonly lossRatio: number };
  /** Base load varies by +/- this ratio around the scenario value. */
  readonly load: { readonly noiseRatio: number };
}

export interface RoomState {
  readonly id: string;
  readonly tempC: Celsius;
  readonly humidityPct: Pct;
}

export interface HomeState {
  readonly socPct: Pct;
  readonly rooms: readonly RoomState[];
}

export interface RoomInputs {
  readonly id: string;
  readonly occupants: readonly string[];
  readonly hvac?: { readonly mode: HvacMode; readonly setpointC: Celsius };
  readonly fanOn: boolean;
}

export interface HomeInputs {
  readonly outC: Celsius;
  readonly outRhPct: Pct;
  readonly irradianceWm2: number;
  readonly baseLoadW: Watt;
  readonly gridAvailable: boolean;
  /** Rooms not listed have no occupants, no HVAC and no fan on. */
  readonly rooms: readonly RoomInputs[];
}

export interface HomeFlows extends Dispatch {
  /** PV the panels could produce (before curtailment). */
  readonly pvW: Watt;
  /** Load the house asks for (served + unserved). */
  readonly loadW: Watt;
  readonly hvacW: Watt;
  readonly fansW: Watt;
}

export interface HomeStep {
  readonly state: HomeState;
  readonly flows: HomeFlows;
}

export function stepHome(args: { state: HomeState; inputs: HomeInputs; profile: HomeProfile; params: SimParams; dt: Minutes; noise: number }): HomeStep {
  const { state, inputs, profile, params, dt } = args;

  const rooms = state.rooms.map((rs) => {
    const room = profile.rooms.find((r) => r.id === rs.id);
    if (room === undefined) throw new Error(`Room "${rs.id}" is not in the home profile`);
    const input = inputs.rooms.find((r) => r.id === rs.id);
    const aperture = params.solarApertureM2.byRoom[rs.id] ?? params.solarApertureM2.default;
    const gainsW = watt(params.gains.perRoomBaseW + params.gains.perOccupantW * (input?.occupants.length ?? 0) + inputs.irradianceWm2 * aperture);
    const hvac: HvacResponse =
      input?.hvac === undefined
        ? hvacResponse([], 'off', watt(0), params.hvac)
        : hvacResponse(
            room.hvacUnits,
            input.hvac.mode,
            coolingToReachW({ tempC: rs.tempC, outC: inputs.outC, targetC: input.hvac.setpointC, gainsW, dt, thermal: room.thermal }),
            params.hvac,
          );
    const fansW = input?.fanOn === true ? room.fans.reduce((sum, f) => sum + f.powerW, 0) : 0;
    return { rs, room, gainsW, hvac, fansW };
  });

  const hvacW = rooms.reduce((sum, r) => sum + r.hvac.electricW, 0);
  const fansW = rooms.reduce((sum, r) => sum + r.fansW, 0);
  const baseW = inputs.baseLoadW * (1 + params.load.noiseRatio * (2 * args.noise - 1));
  const loadW = watt(baseW + hvacW + fansW);
  const pvW = pvPowerW({ peakW: profile.pvPeakW, irradianceWm2: inputs.irradianceWm2, lossRatio: params.pv.lossRatio });

  const flows = dispatch({
    pvW,
    loadW,
    socPct: state.socPct,
    gridAvailable: inputs.gridAvailable,
    dt,
    battery: profile.battery,
    acLimitW: acLimitW(profile, inputs.gridAvailable),
  });
  // Off grid, a shortfall is shared by every load: the HVAC delivers only the served fraction.
  const servedRatio = loadW > 0 ? flows.servedLoadW / loadW : 1;

  const nextRooms = rooms.map(({ rs, room, gainsW, hvac }): RoomState => {
    const tempC = stepRoomTemperature({ tempC: rs.tempC, outC: inputs.outC, netHeatW: watt(gainsW - hvac.coolingW * servedRatio), dt, thermal: room.thermal });
    const removal =
      hvac.dehumidifying === 'dry'
        ? params.humidity.dryRemovalPctPerH
        : hvac.dehumidifying === 'cool'
          ? params.humidity.coolRemovalPctPerH * hvac.duty
          : 0;
    const humidityPct = stepRoomHumidity({
      rhPct: rs.humidityPct,
      equilibriumPct: indoorEquilibriumRh({ outC: inputs.outC, outRhPct: inputs.outRhPct, inC: tempC }),
      dt,
      exchangeTimeConstantH: params.humidity.exchangeTimeConstantH,
      removalPctPerH: removal * servedRatio,
    });
    return { id: rs.id, tempC, humidityPct };
  });

  return {
    state: { socPct: flows.nextSocPct, rooms: nextRooms },
    flows: { ...flows, pvW, loadW, hvacW: watt(hvacW), fansW: watt(fansW) },
  };
}
