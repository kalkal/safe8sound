import { surplusWindow } from './surplus.js';

// A household tip from the solar surplus (#219, owner decisions of 4/10): which load fits the window where the
// plan still exports, the longest cycle first (eco, then normal, then quick, then cooking). Advice only: it
// changes nothing at home. Durations and powers come from config, with their sources.

export interface TipOption {
  readonly load: 'washing' | 'cooking';
  readonly cycle?: 'eco' | 'normal' | 'quick' | undefined;
  readonly durationH: number;
  /** Mean draw over the cycle: the export must cover it, or the cycle imports. */
  readonly meanW: number;
  /** Peak draw (heating water): with the load already planned it must stay within the inverter limit. */
  readonly peakW: number;
}

export interface HouseholdTip {
  readonly option: TipOption;
  readonly fromMs: number;
  readonly toMs: number;
}

/** The first option, in the given order, whose surplus window is long enough and whose peak fits the inverter. */
export function chooseHouseholdTip(
  points: readonly { readonly ms: number; readonly socPct: number; readonly flows: { readonly gridExportW: number; readonly servedLoadW: number } }[],
  opts: { readonly options: readonly TipOption[]; readonly stepMs: number; readonly acLimitW: number; readonly minSocPct?: number },
): HouseholdTip | undefined {
  for (const option of opts.options) {
    const window = surplusWindow(points, { minExportW: option.meanW, stepMs: opts.stepMs, ...(opts.minSocPct === undefined ? {} : { minSocPct: opts.minSocPct }) });
    if (window === undefined || window.toMs - window.fromMs < option.durationH * 3_600_000) continue;
    const inWindow = points.filter((p) => p.ms >= window.fromMs && p.ms < window.toMs);
    const peakLoadW = Math.max(...inWindow.map((p) => p.flows.servedLoadW));
    if (peakLoadW + option.peakW > opts.acLimitW) continue;
    return { option, fromMs: window.fromMs, toMs: window.toMs };
  }
  return undefined;
}
