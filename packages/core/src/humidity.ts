import { pct, type Celsius, type Minutes, type Pct } from '@cold-reserve/contracts';

// Room relative humidity, kept simple and declared (plan §4ter):
// - air exchange pulls the room toward the outdoor water vapour at the room temperature,
//   with a time constant (infiltration);
// - running units remove moisture at a configured rate (%RH per hour).

/** Magnus formula over water (Alduchov & Eskridge 1996), hPa. */
export const saturationVaporPressureHpa = (tC: Celsius): number => 6.1094 * Math.exp((17.625 * tC) / (tC + 243.04));

const clampPct = (x: number): Pct => pct(Math.min(100, Math.max(0, x)));

/** RH the room would reach with outdoor air only: same vapour pressure, room temperature. */
export function indoorEquilibriumRh(input: { outC: Celsius; outRhPct: Pct; inC: Celsius }): Pct {
  const vapour = (input.outRhPct / 100) * saturationVaporPressureHpa(input.outC);
  return clampPct((vapour / saturationVaporPressureHpa(input.inC)) * 100);
}

export function stepRoomHumidity(input: { rhPct: Pct; equilibriumPct: Pct; dt: Minutes; exchangeTimeConstantH: number; removalPctPerH: number }): Pct {
  const hours = input.dt / 60;
  const relaxed = input.equilibriumPct + (input.rhPct - input.equilibriumPct) * Math.exp(-hours / input.exchangeTimeConstantH);
  return clampPct(relaxed - input.removalPctPerH * hours);
}
