import { nwsHeatIndexC } from '@cold-reserve/core';

// Heat danger in the safe room (#248, approved in #248). Refused: the air above the limit in force, or the NWS heat
// index above it (rounded to 0.5 °C, so humid air that adds a tenth does not refuse: 24 °C at 69 % reads 24 °C).
// Whatever the limit, two fixed caps: a heat index from 32.2 °C (NWS Extreme Caution,
// https://www.weather.gov/ama/heatindex) for everyone, and air above 31 °C with an older person (Health Canada,
// upper indoor temperature limits for older adults). Health thresholds, never settings. Humid air alone is a
// warning (humid-air.ts): the 60 % of indoor-air guidance is about comfort and mould, not heat.

export const EXTREME_CAUTION_HEAT_INDEX_C = 32.2;
export const ELDERLY_CRITICAL_C = 31;

const DEFAULT_EPS = 1e-6;

export type HeatDangerRule = 'temperature' | 'heat_index' | 'extreme_caution' | 'elderly_critical';

export interface HeatDanger {
  readonly rule: HeatDangerRule;
  /** The air temperature or the heat index that breaks the rule, °C. */
  readonly valueC: number;
  readonly limitC: number;
}

interface Reading {
  readonly tempC: number;
  readonly humidityPct: number;
}

/** The NWS heat index rounded to 0.5 °C. */
export const roundedHeatIndexC = (r: Reading): number => Math.round(nwsHeatIndexC(r.tempC, r.humidityPct) * 2) / 2;

/** The first rule a reading breaks, or undefined when it is not dangerous. */
export function heatDanger(r: Reading, opts: { limitC: number; elderly: boolean; eps?: number }): HeatDanger | undefined {
  // The caller's tolerance on the limits: the guard's, or safe-until's finer one.
  const EPS = opts.eps ?? DEFAULT_EPS;
  if (r.tempC > opts.limitC + EPS) return { rule: 'temperature', valueC: r.tempC, limitC: opts.limitC };
  if (opts.elderly && r.tempC > ELDERLY_CRITICAL_C + EPS) return { rule: 'elderly_critical', valueC: r.tempC, limitC: ELDERLY_CRITICAL_C };
  const exact = nwsHeatIndexC(r.tempC, r.humidityPct);
  if (exact >= EXTREME_CAUTION_HEAT_INDEX_C - EPS) return { rule: 'extreme_caution', valueC: Math.round(exact * 10) / 10, limitC: EXTREME_CAUTION_HEAT_INDEX_C };
  const rounded = roundedHeatIndexC(r);
  if (rounded > opts.limitC + EPS) return { rule: 'heat_index', valueC: rounded, limitC: opts.limitC };
  return undefined;
}

const r1 = (x: number) => Math.round(x * 10) / 10 + 0;

/** The guard's reason for a dangerous reading, with its numbers. */
export function heatDangerReason(r: Reading, d: HeatDanger): string {
  const air = `${r1(r.tempC).toString()} °C at ${Math.round(r.humidityPct).toString()} % humidity`;
  const value = r1(d.valueC).toString();
  switch (d.rule) {
    case 'temperature':
      return `The safe room would reach ${value} °C, above its ${d.limitC.toString()} °C maximum.`;
    case 'elderly_critical':
      return `The safe room would reach ${value} °C, above the ${d.limitC.toString()} °C that is critical for an older person.`;
    case 'extreme_caution':
      return `The safe room would feel like ${value} °C (${air}), in the heat index's Extreme Caution band from ${d.limitC.toString()} °C.`;
    case 'heat_index':
      return `The safe room would feel like ${value} °C (${air}), above its ${d.limitC.toString()} °C maximum.`;
  }
}
