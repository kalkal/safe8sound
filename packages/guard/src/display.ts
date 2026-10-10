import { formatTemp, formatTempForInput, toDisplayTemp, type TempUnit } from '@cold-reserve/contracts';

// The guard computes in °C; its words follow the unit the person chose (#306, decided in #306). Only these strings
// change: every number of a verdict, its pass or fail and its structured fields stay in °C.

/** "27 °C", "80.6 °F". */
export const temp = (c: number, unit: TempUnit): string => formatTemp(c, unit);

/** A bare number in the chosen unit, for "between 24 and 25.5 °C". */
export const tempNumber = (c: number, unit: TempUnit): string => String(toDisplayTemp(c, unit));

/** The NWS heat-index threshold the night's heat budget counts above. */
const HEAT_BUDGET_FROM_C = 26.7;

/** A heat-index degree-hour budget (a sum of differences, not an absolute): x1.8 in °F, to one decimal. */
export const degreeHours = (dh: number, unit: TempUnit): string => String(unit === 'F' ? Math.round(dh * 18) / 10 : dh);

/**
 * An amount of heat against that budget: in °F rounded up to the tenth, so an amount just over the budget is never
 * said as equal to it ("7.3 over the 7.2", never "7.2 over the 7.2", #306 review).
 */
export const heatAmountValue = (dh: number, unit: TempUnit): string => String(unit === 'F' ? Math.ceil(Math.round(dh * 18 * 1e6) / 1e6) / 10 : dh);

/** "7.2 heat-index degree-hours above 26.7 °C", "13 heat-index °F-hours above 80.1 °F". */
export const heatAmount = (dh: number, unit: TempUnit): string =>
  `${heatAmountValue(dh, unit)} heat-index ${unit === 'F' ? '°F-hours' : 'degree-hours'} above ${temp(HEAT_BUDGET_FROM_C, unit)}`;

/** A value the tools take in °C: "80.6 °F (27 C)" in °F, "27 C" in °C. */
export const inputTemp = (c: number, unit: TempUnit): string => formatTempForInput(c, unit);
