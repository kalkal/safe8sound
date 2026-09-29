import { kilowattToWatt, watt, type HvacMode, type HvacUnit, type Watt } from '@cold-reserve/contracts';

// Simple, declared split model (spike S6, Hisense Easy Smart datasheet):
// - cool/heat: thermal power = electric input x COP, COP = rated cooling / nominal input;
//   capped at the maximum input. Below the minimum input the unit cycles, so the average still scales.
// - dry: compressor at low speed until the set point, with a fixed fraction of the nominal input and of
//   the rated cooling (both assumptions from S6, to calibrate with ConnectLife kWh).
// - fan_only: fan power only.

export interface HvacModelParams {
  /** Dry-mode input as a fraction of the nominal cooling input. */
  readonly dryInputFactor: number;
  /** Dry-mode sensible cooling as a fraction of the rated cooling. */
  readonly drySensibleFactor: number;
  readonly fanOnlyInputW: number;
}

export type Dehumidifying = 'none' | 'cool' | 'dry';

export interface HvacResponse {
  readonly electricW: Watt;
  /** Heat removed from the room; negative when heating. */
  readonly coolingW: Watt;
  readonly dehumidifying: Dehumidifying;
  /** Delivered / maximum thermal power, 0-1. */
  readonly duty: number;
}

const IDLE: HvacResponse = { electricW: watt(0), coolingW: watt(0), dehumidifying: 'none', duty: 0 };

const cop = (u: HvacUnit): number => u.coolingKw / u.inputKw.nominal;

interface Share {
  readonly capW: number;
  readonly perThermalW: (thermalW: number) => number;
}

/** Fills the units in order until the need is met. */
function fill(units: readonly Share[], needW: number): { deliveredW: number; electricW: number; capW: number } {
  let left = needW;
  let electricW = 0;
  let capW = 0;
  for (const u of units) {
    const give = Math.min(left, u.capW);
    left -= give;
    electricW += u.perThermalW(give);
    capW += u.capW;
  }
  return { deliveredW: needW - left, electricW, capW };
}

/**
 * What the room's units do in `mode`, given the cooling that would bring the room to its set point
 * (`coolingNeedW`, negative = heat needed; from `coolingToReachW`). Units without the mode stay off.
 */
export function hvacResponse(units: readonly HvacUnit[], mode: HvacMode, coolingNeedW: Watt, params: HvacModelParams): HvacResponse {
  const able = units.filter((u) => u.modes.includes(mode));
  if (mode === 'off' || able.length === 0) return IDLE;
  if (mode === 'fan_only') return { ...IDLE, electricW: watt(params.fanOnlyInputW * able.length) };
  if (mode === 'auto' || mode === 'heat_cool') return hvacResponse(able, coolingNeedW >= 0 ? 'cool' : 'heat', coolingNeedW, params);

  if (mode === 'dry') {
    const need = Math.max(0, coolingNeedW);
    if (need === 0) return { ...IDLE, electricW: watt(params.fanOnlyInputW * able.length) };
    const r = fill(
      able.map((u) => ({ capW: kilowattToWatt(u.coolingKw) * params.drySensibleFactor, perThermalW: () => 0 })),
      need,
    );
    const electricW = able.reduce((sum, u) => sum + kilowattToWatt(u.inputKw.nominal) * params.dryInputFactor, 0);
    return { electricW: watt(electricW), coolingW: watt(r.deliveredW), dehumidifying: 'dry', duty: r.capW > 0 ? r.deliveredW / r.capW : 0 };
  }

  // cool or heat
  const needW: number = coolingNeedW;
  const need = mode === 'cool' ? Math.max(0, needW) : Math.max(0, -needW);
  const r = fill(
    able.map((u) => ({ capW: kilowattToWatt(u.inputKw.max) * cop(u), perThermalW: (w: number) => w / cop(u) })),
    need,
  );
  return {
    electricW: watt(r.electricW),
    coolingW: watt(mode === 'cool' ? r.deliveredW : -r.deliveredW),
    dehumidifying: mode === 'cool' && r.deliveredW > 0 ? 'cool' : 'none',
    duty: r.capW > 0 ? r.deliveredW / r.capW : 0,
  };
}
