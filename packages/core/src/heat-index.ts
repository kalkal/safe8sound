// The NWS heat index (#248), for the guard's heat-danger rule; the comfort levels use feelsLikeC (comfort.ts).
// Method, from https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml: the simple formula, averaged with the
// temperature; where that reaches 80 °F, the Rothfusz regression with its dry-air and humid-air adjustments.

const toF = (c: number) => c * 1.8 + 32;
const toC = (f: number) => (f - 32) / 1.8;

/** The heat index in °C from the air temperature (°C) and relative humidity (%). */
export function nwsHeatIndexC(tempC: number, rhPct: number): number {
  const t = toF(tempC);
  const rh = rhPct;
  const simple = (0.5 * (t + 61 + (t - 68) * 1.2 + rh * 0.094) + t) / 2;
  if (simple < 80) return toC(simple);
  let hi =
    -42.379 +
    2.04901523 * t +
    10.14333127 * rh -
    0.22475541 * t * rh -
    0.00683783 * t * t -
    0.05481717 * rh * rh +
    0.00122874 * t * t * rh +
    0.00085282 * t * rh * rh -
    0.00000199 * t * t * rh * rh;
  if (rh < 13 && t >= 80 && t <= 112) hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(t - 95)) / 17);
  if (rh > 85 && t >= 80 && t <= 87) hi += ((rh - 85) / 10) * ((87 - t) / 5);
  return toC(hi);
}
