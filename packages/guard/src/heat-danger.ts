import { ELDERLY_CAP_MAX_C, HEAT_INDEX_CAP_MAX_C, type TempUnit } from '@cold-reserve/contracts';
import { temp } from './display.js';
import { nwsHeatIndexC } from '@cold-reserve/core';

// Heat danger in the safe room (#248, approved in #248). Refused: the air above the limit in force, or the NWS heat
// index above it (rounded to 0.5 °C, so humid air that adds a tenth does not refuse: 24 °C at 69 % reads 24 °C).
// Whatever the limit, two fixed caps: a heat index from 32.2 °C (NWS Extreme Caution,
// https://www.weather.gov/ama/heatindex) for everyone, and air above 31 °C with an older person (Health Canada,
// upper indoor temperature limits for older adults). Health thresholds, never settings. Humid air alone is a
// warning (humid-air.ts): the 60 % of indoor-air guidance is about comfort and mould, not heat.

// The person may set both caps stricter, never looser (#266): the constants live in contracts, where the bounds are.
export const EXTREME_CAUTION_HEAT_INDEX_C = HEAT_INDEX_CAP_MAX_C;
export const ELDERLY_CRITICAL_C = ELDERLY_CAP_MAX_C;

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
/** The caps in force: the health constants, or stricter ones from the settings (effectiveHeatSafety, #266). */
export interface HeatCaps {
  readonly heatIndexC: number;
  readonly elderlyC: number;
}

const HEALTH_CAPS: HeatCaps = { heatIndexC: EXTREME_CAUTION_HEAT_INDEX_C, elderlyC: ELDERLY_CRITICAL_C };

export function heatDanger(r: Reading, opts: { limitC: number; elderly: boolean; eps?: number; caps?: HeatCaps }): HeatDanger | undefined {
  // Never looser than the health constants, whatever the caller passes.
  const capHi = Math.min(opts.caps?.heatIndexC ?? HEALTH_CAPS.heatIndexC, HEALTH_CAPS.heatIndexC);
  const capElderly = Math.min(opts.caps?.elderlyC ?? HEALTH_CAPS.elderlyC, HEALTH_CAPS.elderlyC);
  // The caller's tolerance on the limits: the guard's, or safe-until's finer one.
  const EPS = opts.eps ?? DEFAULT_EPS;
  if (r.tempC > opts.limitC + EPS) return { rule: 'temperature', valueC: r.tempC, limitC: opts.limitC };
  if (opts.elderly && r.tempC > capElderly + EPS) return { rule: 'elderly_critical', valueC: r.tempC, limitC: capElderly };
  const exact = nwsHeatIndexC(r.tempC, r.humidityPct);
  if (exact >= capHi - EPS) return { rule: 'extreme_caution', valueC: Math.round(exact * 10) / 10, limitC: capHi };
  const rounded = roundedHeatIndexC(r);
  if (rounded > opts.limitC + EPS) return { rule: 'heat_index', valueC: rounded, limitC: opts.limitC };
  return undefined;
}

const r1 = (x: number) => Math.round(x * 10) / 10 + 0;

/** The guard's reason for a dangerous reading, with its numbers. */
export function heatDangerReason(r: Reading, d: HeatDanger, unit: TempUnit = 'C'): string {
  const air = `${temp(r1(r.tempC), unit)} at ${Math.round(r.humidityPct).toString()} % humidity`;
  const value = temp(r1(d.valueC), unit);
  const limit = temp(d.limitC, unit);
  switch (d.rule) {
    case 'temperature':
      return `The safe room would reach ${value}, above its ${limit} maximum.`;
    case 'elderly_critical':
      return d.limitC < ELDERLY_CRITICAL_C
        ? `The safe room would reach ${value}, above the ${limit} set for an older person.`
        : `The safe room would reach ${value}, above the ${limit} that is critical for an older person.`;
    case 'extreme_caution':
      return d.limitC < EXTREME_CAUTION_HEAT_INDEX_C
        ? `The safe room would feel like ${value} (${air}), above the ${limit} heat-index cap set for this home.`
        : `The safe room would feel like ${value} (${air}), in the heat index's Extreme Caution band from ${limit}.`;
    case 'heat_index':
      return `The safe room would feel like ${value} (${air}), above its ${limit} maximum.`;
  }
}
