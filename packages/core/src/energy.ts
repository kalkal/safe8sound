import { pct, watt, type HomeProfile, type Minutes, type Pct, type Watt } from '@cold-reserve/contracts';

// Battery and power flows of a hybrid inverter, kept simple and declared (plan §3.1, spike S6):
// - self-consumption: PV feeds the house first, then charges the battery, then goes to the grid;
//   a deficit is covered by the battery first, then by the grid;
// - the battery charges and discharges at most at its rated power, between the hardware floor and 100 %;
// - the round-trip efficiency is split evenly: sqrt(eff) on the way in and on the way out;
// - the inverter AC output (PV to house and grid + battery discharge) is capped by its AC rating on grid
//   and by the EPS rating off grid (VA taken as W, power factor 1). Grid imports bypass the inverter;
// - off grid nothing is imported or exported: surplus PV is curtailed, missing load is not served.

export type BatterySpec = HomeProfile['battery'];

/** Energy per 100 % of SOC, chosen so that the span from the hardware floor to 100 % is the usable energy. */
export const batteryCapacityWh = (b: BatterySpec): number => b.usableWh / ((100 - b.minSocHwPct) / 100);

/** What the inverter can deliver on its AC side. */
export const acLimitW = (profile: HomeProfile, gridAvailable: boolean): Watt =>
  gridAvailable ? profile.inverterMaxAcW : watt(profile.eps.continuousVa);

export interface DispatchInput {
  readonly pvW: Watt;
  readonly loadW: Watt;
  readonly socPct: Pct;
  readonly gridAvailable: boolean;
  readonly dt: Minutes;
  readonly battery: BatterySpec;
  readonly acLimitW: Watt;
}

/** All flows are non-negative averages over the step, in W. */
export interface Dispatch {
  readonly pvUsedW: Watt;
  readonly curtailedW: Watt;
  readonly chargeW: Watt;
  readonly dischargeW: Watt;
  readonly gridImportW: Watt;
  readonly gridExportW: Watt;
  /** Import minus export, as in the snapshot. */
  readonly gridW: Watt;
  readonly servedLoadW: Watt;
  readonly unservedLoadW: Watt;
  readonly nextSocPct: Pct;
}

export function dispatch(input: DispatchInput): Dispatch {
  const { battery } = input;
  const hours = input.dt / 60;
  const eta = Math.sqrt(battery.roundTripEff);
  const capacityWh = batteryCapacityWh(battery);
  const pv = Math.max(0, input.pvW);
  const load = Math.max(0, input.loadW);
  const acLimit = Math.max(0, input.acLimitW);

  // Energy the battery can still take in or give out over this step, as AC-side power.
  const headroomW = (Math.max(0, 100 - input.socPct) / 100) * capacityWh / eta / hours;
  const availableW = (Math.max(0, input.socPct - battery.minSocHwPct) / 100) * capacityWh * eta / hours;

  const pvToLoad = Math.min(pv, load, acLimit);
  let surplus = pv - pvToLoad;
  const charge = Math.min(surplus, battery.maxChargeW, headroomW);
  surplus -= charge;
  const gridExport = input.gridAvailable ? Math.min(surplus, acLimit - pvToLoad) : 0;
  const curtailed = surplus - gridExport;

  let deficit = load - pvToLoad;
  const discharge = Math.max(0, Math.min(deficit, battery.maxDischargeW, availableW, acLimit - pvToLoad - gridExport));
  deficit -= discharge;
  const gridImport = input.gridAvailable ? deficit : 0;
  const unserved = input.gridAvailable ? 0 : deficit;

  const deltaPct = ((charge * eta - discharge / eta) * hours / capacityWh) * 100;
  // Clamp only rounding noise: the headroom and availability above keep the result in range.
  const floor = Math.min(battery.minSocHwPct, input.socPct);
  const nextSocPct = Math.min(100, Math.max(floor, input.socPct + deltaPct));

  return {
    pvUsedW: watt(pv - curtailed),
    curtailedW: watt(curtailed),
    chargeW: watt(charge),
    dischargeW: watt(discharge),
    gridImportW: watt(gridImport),
    gridExportW: watt(gridExport),
    gridW: watt(gridImport - gridExport),
    servedLoadW: watt(load - unserved),
    unservedLoadW: watt(unserved),
    nextSocPct: pct(nextSocPct),
  };
}
