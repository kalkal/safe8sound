import { celsius, type Celsius, type Pct } from '@cold-reserve/contracts';

// Feels-like temperature, for the comfort levels only (plan §4ter, decision #1·24): the safety
// guarantee always uses the measured air temperature and humidity, never this value.
// Method: NOAA heat index (Rothfusz regression with its two adjustments), used only from 80 °F
// (26.7 °C), where it is defined; below that the air temperature. The heat index is never taken
// below the air temperature. A running fan lowers the result by a configured, conservative effect
// (spike S6: 1.5 °C, CBE fans guidebook).

const toF = (c: number) => c * 1.8 + 32;
const toC = (f: number) => (f - 32) / 1.8;

function heatIndexF(t: number, rh: number): number {
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
  return hi;
}

export function feelsLikeC(input: { tempC: Celsius; rhPct: Pct; fanOn: boolean; fanEffectC: number }): Celsius {
  const tF = toF(input.tempC);
  const still = tF < 80 ? input.tempC : Math.max(input.tempC, toC(heatIndexF(tF, input.rhPct)));
  return celsius(still - (input.fanOn ? input.fanEffectC : 0));
}
