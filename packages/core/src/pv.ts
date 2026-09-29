import { watt, type Watt } from '@cold-reserve/contracts';

/** Standard test conditions: the irradiance at which a module delivers its peak power. */
const STC_IRRADIANCE_WM2 = 1000;

/** PV output = peak x irradiance (relative to STC) x (1 - system losses). */
export function pvPowerW(input: { peakW: Watt; irradianceWm2: number; lossRatio: number }): Watt {
  return watt(Math.max(0, input.peakW * (input.irradianceWm2 / STC_IRRADIANCE_WM2) * (1 - input.lossRatio)));
}
