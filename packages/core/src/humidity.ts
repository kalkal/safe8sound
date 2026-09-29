import { celsius, pct, type Celsius, type Minutes, type Pct } from '@cold-reserve/contracts';

// Room humidity as a water balance of the room air, kept simple and declared (plan §4ter):
// - air exchange pulls the room's vapour density toward the outdoor one, with a time constant
//   (infiltration);
// - occupants and household activities add water (g/h);
// - running splits remove water (g/h). Removal is linear in the vapour above the coil dew point: the
//   datasheet capacity (l/h) at the rating condition of the datasheet, more in more humid air, nothing at
//   the coil dew point. So the air never dries below it, as on a real coil.
// The balance has an exact solution over a step (linear ODE), so any step length is stable.

/** Magnus formula over water (Alduchov & Eskridge 1996), hPa. */
export const saturationVaporPressureHpa = (tC: Celsius): number => 6.1094 * Math.exp((17.625 * tC) / (tC + 243.04));

const clampPct = (x: number): Pct => pct(Math.min(100, Math.max(0, x)));

/** RH the room would reach with outdoor air only: same vapour pressure, room temperature. */
export function indoorEquilibriumRh(input: { outC: Celsius; outRhPct: Pct; inC: Celsius }): Pct {
  const vapour = (input.outRhPct / 100) * saturationVaporPressureHpa(input.outC);
  return clampPct((vapour / saturationVaporPressureHpa(input.inC)) * 100);
}

/** Specific gas constant of water vapour, J/(kg K). */
const R_VAPOUR = 461.5;

export interface MoistureStep {
  readonly rhPct: Pct;
  /** Room temperature at the start of the step and at its end. */
  readonly tempC: Celsius;
  readonly nextTempC: Celsius;
  readonly outC: Celsius;
  readonly outRhPct: Pct;
  readonly dt: Minutes;
  readonly volumeM3: number;
  readonly exchangeTimeConstantH: number;
  /** Water added to the room air, g/h. */
  readonly gainsGph: number;
  /** Removal of the running units at the rating condition, g/h (datasheet l/h x share). */
  readonly removalGph: number;
  /** Indoor air of the datasheet rating (EN 14511: 27 °C dry bulb, 19 °C wet bulb, about 47 % RH). */
  readonly rating: { readonly tempC: number; readonly rhPct: number };
  /** Coil dew point: the air is never dried below it. */
  readonly coilDewpointC: number;
}

/**
 * Relative humidity at the end of the step. The state is the vapour pressure e (hPa): air exchange
 * equalises it with the outdoor one; grams of water become hPa through the ideal gas law at the room
 * temperature: de = dm x R_v x T / V.
 *   de/dt = (e_out - e)/tau + c G - k (e - e_coil),   c = R_v T / V,   k (e_rating - e_coil) = c R.
 */
export function stepRoomMoisture(input: MoistureStep): Pct {
  const hours = input.dt / 60;
  const tau = input.exchangeTimeConstantH;
  const e0 = (input.rhPct / 100) * saturationVaporPressureHpa(input.tempC);
  const eSat = saturationVaporPressureHpa(input.nextTempC);
  const eOut = (input.outRhPct / 100) * saturationVaporPressureHpa(input.outC);
  const eCoil = Math.min(saturationVaporPressureHpa(celsius(input.coilDewpointC)), eSat);
  // hPa per gram of water in the room: R_v [J/(kg K)] x T [K] / V [m³] / 1000 [g/kg] / 100 [Pa/hPa].
  const hpaPerGram = (R_VAPOUR * (input.nextTempC + 273.15)) / input.volumeM3 / 1000 / 100;

  const solve = (k: number) => {
    const b = 1 / tau + k;
    const a = eOut / tau + hpaPerGram * input.gainsGph + k * eCoil;
    const steady = a / b;
    return steady + (e0 - steady) * Math.exp(-b * hours);
  };
  const passive = solve(0);
  const eRating = (input.rating.rhPct / 100) * saturationVaporPressureHpa(celsius(input.rating.tempC));
  const span = eRating - eCoil;
  const k = input.removalGph > 0 && span > 0 ? (hpaPerGram * input.removalGph) / span : 0;
  // The coil only removes water: it never takes the air below its dew point, nor adds any.
  const e = Math.max(Math.min(solve(k), passive), Math.min(passive, eCoil));
  return clampPct((Math.min(Math.max(e, 0), eSat) / eSat) * 100);
}
