import { describe, expect, it } from 'vitest';
import { chooseHouseholdTip, type TipOption } from '../src/household-tip.js';

// A household tip from the solar surplus (#219): the longest cycle that fits the window where the plan still
// exports enough, within the inverter limit with the load already planned. Advice only.

const STEP = 5 * 60_000;
const T0 = Date.parse('2026-07-16T12:00:00Z');
const H = 3_600_000;
const OPTIONS: TipOption[] = [
  { load: 'washing', cycle: 'eco', durationH: 3.75, meanW: 500, peakW: 2_000 },
  { load: 'washing', cycle: 'normal', durationH: 2, meanW: 800, peakW: 2_000 },
  { load: 'washing', cycle: 'quick', durationH: 1, meanW: 1_000, peakW: 2_000 },
  { load: 'cooking', durationH: 1, meanW: 1_500, peakW: 2_000 },
];
/** `exportW` on the hour from T0 for `hours`, then nothing; a planned load of `loadW` everywhere. */
const day = (exportW: number, hours: number, loadW = 1_000) =>
  Array.from({ length: 12 * 8 }, (_, i) => ({ ms: T0 + i * STEP, socPct: 100, flows: { gridExportW: i < hours * 12 ? exportW : 0, servedLoadW: loadW } }));
const opts = { options: OPTIONS, stepMs: STEP, acLimitW: 6_000 };

describe('chooseHouseholdTip', () => {
  it('a long window: the eco cycle, with the window it fits in', () => {
    expect(chooseHouseholdTip(day(2_000, 5), opts)).toEqual({ option: OPTIONS[0], fromMs: T0, toMs: T0 + 5 * H });
  });

  it('a window of two to three hours: the normal cycle; one hour: the quick one; shorter: nothing', () => {
    expect(chooseHouseholdTip(day(2_000, 2.5), opts)?.option.cycle).toBe('normal');
    expect(chooseHouseholdTip(day(2_000, 1.5), opts)?.option.cycle).toBe('quick');
    expect(chooseHouseholdTip(day(2_000, 0.5), opts)).toBeUndefined();
  });

  it('the export must cover the cycle’s mean power: a thin surplus fits only the light cycles', () => {
    expect(chooseHouseholdTip(day(600, 5), opts)?.option.cycle).toBe('eco');
    expect(chooseHouseholdTip(day(400, 5), opts)).toBeUndefined();
  });

  it('the peak with the load already planned must stay within the inverter limit, or the next option is tried', () => {
    expect(chooseHouseholdTip(day(2_000, 5, 4_500), opts)).toBeUndefined();
    expect(chooseHouseholdTip(day(2_000, 5, 4_100), { ...opts, options: [OPTIONS[0] as TipOption, { ...(OPTIONS[3] as TipOption), peakW: 1_500 }] })).toMatchObject({ option: { load: 'cooking' } });
  });
});
