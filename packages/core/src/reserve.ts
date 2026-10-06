import { pct, wattHour, type Forecast, type Pct, type Watt } from '@cold-reserve/contracts';
import { batteryCapacityWh, type BatterySpec } from './energy.js';
import { pvPowerW } from './pv.js';

// Reserve and hours, the single definitions of plan §3.1.

const HOUR_MS = 3_600_000;

/**
 * Energy the battery can deliver above `floorPct` (default: the hardware floor):
 * (soc - floor) x capacity x round-trip efficiency. Conservative on purpose: the plan counts the whole
 * round-trip loss, the simulator only the discharge half.
 */
export function usableWh(battery: BatterySpec, socPct: Pct, floorPct: Pct = battery.minSocHwPct): number {
  const floor = Math.max(floorPct, battery.minSocHwPct);
  return (Math.max(0, socPct - floor) / 100) * batteryCapacityWh(battery) * battery.roundTripEff;
}

/** Energy kept for a storm: the essential load through the dark hours, with the losses, up to a cap (config). */
export function reserveWh(input: { essentialLoadW: number; darkHours: number; roundTripEff: number; capWh: number }): number {
  return Math.min((input.essentialLoadW * Math.max(0, input.darkHours)) / input.roundTripEff, input.capWh);
}

/** SOC below which the battery must not go while the grid is up: hardware floor + reserve share. */
export function reserveFloorSocPct(battery: BatterySpec, reserve: number): Pct {
  return pct(Math.min(100, battery.minSocHwPct + (reserve / batteryCapacityWh(battery)) * 100));
}

/** Hours the battery alone sustains `loadW` from `socPct` down to `floorPct` (the "ice cubes"). */
export function hoursAtLoad(battery: BatterySpec, socPct: Pct, loadW: number, floorPct: Pct = battery.minSocHwPct): number {
  return usableWh(battery, socPct, floorPct) / loadW;
}

/**
 * The reserve counted in hours (ReserveOutlook, the ice cubes; semantics agreed in #21). Both level hours
 * use the same energy: on grid only what comfort may spend (above the reserve floor), off grid everything
 * down to the hardware floor, as the guard does. The reserve alone is its energy after the losses over the
 * essential load, capped by what the battery still holds; on grid it can exceed the spendable hours, so there is
 * no invariant between them.
 */
export function reserveOutlookHours(input: {
  battery: BatterySpec;
  socPct: Pct;
  gridAvailable: boolean;
  reserveFloorSocPct: Pct;
  reserveWh: number;
  currentLoadW: number;
  essentialLoadW: number;
}): { hoursAtCurrentLevel: number; hoursAtEssential: number; reserveHoursAtEssential: number } {
  const energy = input.gridAvailable ? usableWh(input.battery, input.socPct, input.reserveFloorSocPct) : usableWh(input.battery, input.socPct);
  return {
    hoursAtCurrentLevel: energy / input.currentLoadW,
    hoursAtEssential: energy / input.essentialLoadW,
    // Never more than the battery holds above its hardware floor (#273): at the floor the reserve is spent too.
    reserveHoursAtEssential: Math.min(input.reserveWh * input.battery.roundTripEff, usableWh(input.battery, input.socPct)) / input.essentialLoadW,
  };
}

/**
 * The same battery with a higher discharge floor (the inverter's backup reserve): the capacity per
 * percent stays the same, only the usable span shrinks. The floor never goes below the hardware one.
 */
export function withDischargeFloor(battery: BatterySpec, floorPct: Pct): BatterySpec {
  const floor = Math.max(floorPct, battery.minSocHwPct);
  const capacity = batteryCapacityWh(battery);
  return { ...battery, minSocHwPct: pct(floor), usableWh: wattHour(((100 - floor) / 100) * capacity) };
}

/**
 * The dark stretch the reserve has to bridge (plan §4bis.1): from the first forecast hour, at or after
 * `fromMs`, in which PV cannot cover the essential load, to the first later hour in which it can
 * ("sunrise with enough sun"). Undefined when the forecast does not reach that sunrise.
 */
export function darkWindow(input: {
  forecast: Forecast;
  fromMs: number;
  pvPeakW: Watt;
  lossRatio: number;
  essentialLoadW: number;
}): { fromMs: number; toMs: number } | undefined {
  const covers = (irradianceWm2: number) =>
    pvPowerW({ peakW: input.pvPeakW, irradianceWm2, lossRatio: input.lossRatio }) >= input.essentialLoadW - 1e-9;
  const hours = input.forecast.hourly
    .map((h) => ({ ms: Date.parse(h.ts), bright: covers(h.irradianceWm2) }))
    .filter((h) => h.ms + HOUR_MS > input.fromMs)
    .sort((a, b) => a.ms - b.ms);
  const dark = hours.findIndex((h) => !h.bright);
  const darkHour = hours[dark];
  if (darkHour === undefined) return undefined;
  const recharge = hours.slice(dark + 1).find((h) => h.bright);
  if (recharge === undefined) return undefined;
  return { fromMs: Math.max(input.fromMs, darkHour.ms), toMs: recharge.ms };
}
