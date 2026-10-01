import { err, ok, toolError, watt, type Celsius, type ErrorEnvelope, type HomeProfile, type HvacMode, type Minutes, type Pct, type Result, type Watt } from '@cold-reserve/contracts';
import { acLimitW, dispatch, type Dispatch } from './energy.js';
import { hvacResponse, type HvacModelParams, type HvacResponse } from './hvac.js';
import { stepRoomMoisture } from './humidity.js';
import { pvPowerW } from './pv.js';
import { coolingToReachW, stepRoomTemperature } from './thermal.js';

// One step of the whole simulated home: rooms (1R1C + humidity), HVAC, fans, base load, PV, battery.
// Pure: the caller passes the noise draw and the step length; every physical parameter comes from
// the home profile or from `SimParams` (config), never from constants here.

/** Latent heat of vaporisation of water, about 2450 J/g. */
const LATENT_WH_PER_G = 2450 / 3600;

export interface SimParams {
  readonly hvac: HvacModelParams;
  /** Internal heat gains per room, W. */
  readonly gains: { readonly perRoomBaseW: number; readonly perOccupantW: number };
  /** Effective solar aperture (window area x solar gain factor), m², per room with a default. */
  readonly solarApertureM2: { readonly default: number; readonly byRoom: Readonly<Record<string, number>> };
  /** Water balance of the room air (see humidity.ts); sources in the simulator's README. */
  readonly humidity: {
    readonly exchangeTimeConstantH: number;
    /** Room air volume, m³, per room with a default. */
    readonly roomVolumeM3: { readonly default: number; readonly byRoom: Readonly<Record<string, number>> };
    /** Water from one person at rest, g/h. */
    readonly occupantGainGph: number;
    /** Water from household activities per room, g/h. */
    readonly baseGainGph: number;
    /** Dehumidification capacity per kW of rated cooling, l/h (datasheet). */
    readonly removalLphPerCoolingKw: number;
    /** Share of that capacity the dry mode uses (the cool mode uses its duty). */
    readonly dryRemovalFactor: number;
    /** Indoor air at which the datasheet capacity is rated. */
    readonly rating: { readonly tempC: number; readonly rhPct: number };
    readonly coilDewpointC: number;
    /** At most this share of the rated cooling can be latent (drying), however humid the air. */
    readonly maxLatentShare: number;
  };
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

/**
 * The load on the EPS circuits besides the HVAC: the home profile's `epsBaseLoadW`, the one number the
 * simulator, the projection and the storm safe hours use off grid. Missing, it is an error, never assumed:
 * the storm tools refuse with `missing_eps_load`.
 */
export function epsBaseLoadW(profile: HomeProfile): Result<number, ErrorEnvelope> {
  return profile.epsBaseLoadW === undefined
    ? err(toolError('missing_eps_load', 'The home profile does not say what its EPS circuits draw, so nothing is computed for a blackout.'))
    : ok(profile.epsBaseLoadW);
}

export function stepHome(args: { state: HomeState; inputs: HomeInputs; profile: HomeProfile; params: SimParams; dt: Minutes; noise: number }): HomeStep {
  const { state, inputs, profile, params, dt } = args;

  const rooms = state.rooms.map((rs) => {
    const room = profile.rooms.find((r) => r.id === rs.id);
    if (room === undefined) throw new Error(`Room "${rs.id}" is not in the home profile`);
    const asked = inputs.rooms.find((r) => r.id === rs.id);
    // Off grid only the EPS circuits are powered: the safe room's unit and fans; the other rooms keep their
    // people but nothing runs.
    const input = asked === undefined || inputs.gridAvailable || room.isSafeRoom ? asked : { id: asked.id, occupants: asked.occupants, fanOn: false };
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
    return { rs, room, gainsW, hvac, fansW, occupants: input?.occupants.length ?? 0 };
  });

  const hvacW = rooms.reduce((sum, r) => sum + r.hvac.electricW, 0);
  const fansW = rooms.reduce((sum, r) => sum + r.fansW, 0);
  // Off grid the base load is what the EPS circuits draw, not the whole house. Without that number the whole
  // house is drawn: the pessimistic bound, never an assumed figure (the storm tools refuse before using it).
  const eps = epsBaseLoadW(profile);
  const baseLoad = inputs.gridAvailable || !eps.ok ? inputs.baseLoadW : eps.value;
  const baseW = baseLoad * (1 + params.load.noiseRatio * (2 * args.noise - 1));
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

  const nextRooms = rooms.map(({ rs, room, gainsW, hvac, occupants }): RoomState => {
    const tempC = stepRoomTemperature({ tempC: rs.tempC, outC: inputs.outC, netHeatW: watt(gainsW - hvac.coolingW * servedRatio), dt, thermal: room.thermal });
    // Datasheet dehumidification (l/h at the rated cooling) of the units running, scaled by the dry-mode
    // share or, in cool, by the cooling delivered over the rated cooling.
    const dehumidifying = hvac.dehumidifying;
    const ratedKw = dehumidifying === 'none' ? 0 : room.hvacUnits.filter((u) => u.modes.includes(dehumidifying)).reduce((sum, u) => sum + u.coolingKw, 0);
    const capacityGph = ratedKw * params.humidity.removalLphPerCoolingKw * 1000;
    const share = dehumidifying === 'dry' ? params.humidity.dryRemovalFactor : ratedKw > 0 ? Math.min(1, hvac.coolingW / (ratedKw * 1000)) : 0;
    const humidityPct = stepRoomMoisture({
      rhPct: rs.humidityPct,
      tempC: rs.tempC,
      nextTempC: tempC,
      outC: inputs.outC,
      outRhPct: inputs.outRhPct,
      dt,
      volumeM3: params.humidity.roomVolumeM3.byRoom[rs.id] ?? params.humidity.roomVolumeM3.default,
      exchangeTimeConstantH: params.humidity.exchangeTimeConstantH,
      gainsGph: params.humidity.baseGainGph + params.humidity.occupantGainGph * occupants,
      removalGph: capacityGph * share * servedRatio,
      // Latent heat of water ~0.68 Wh/g: at most `maxLatentShare` of the cooling in use (rated × share × served)
      // goes to drying.
      maxRemovalGph: (ratedKw * 1000 * params.humidity.maxLatentShare * share * servedRatio) / LATENT_WH_PER_G,
      rating: params.humidity.rating,
      coilDewpointC: params.humidity.coilDewpointC,
    });
    return { id: rs.id, tempC, humidityPct };
  });

  return {
    state: { socPct: flows.nextSocPct, rooms: nextRooms },
    flows: { ...flows, pvW, loadW, hvacW: watt(hvacW), fansW: watt(fansW) },
  };
}
