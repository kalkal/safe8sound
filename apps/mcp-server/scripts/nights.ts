import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { builtInMonth } from '@cold-reserve/source-simulator';
import { NIGHT_HOURS, berylNight, hottestNights, monthNight, nightsReport, runNight, studySetup, type Night, type NightOutcome, type Sleeper } from './nights-study.js';

// The hottest storm nights (#331): runs the study and writes docs/results/storm-nights.md.
// Usage: pnpm --filter @cold-reserve/mcp-server nights [YYYY-MM-DD]   (the date printed on the page; default today)

/**
 * Starting charges at 22:00: a typical evening, the edge of the last-resort zone (~35 %) and a low battery. With one
 * adult, above 35 % every night is kept with or without the plan (100 % gives the same rows as 60 %).
 */
const CHARGES = [60, 35, 20] as const;
const PER_CITY = 5;
/** One adult (the standard night threshold), then one older person (the elderly threshold). */
const SLEEPERS: readonly Sleeper[] = ['adult', 'older'];

const started = performance.now();
const setup = studySetup();
const { window } = setup;

const nightsOf = (id: 'turin' | 'houston'): Night[] => {
  const month = builtInMonth(id);
  return hottestNights(month, PER_CITY, window).map((n) => monthNight(month, n.date, NIGHT_HOURS, window));
};
const nights = [...nightsOf('turin'), ...nightsOf('houston'), berylNight(builtInMonth('houston'), NIGHT_HOURS, window)];

const outcomes: NightOutcome[] = [];
for (const sleeper of SLEEPERS) for (const soc of CHARGES) for (const night of nights) outcomes.push(await runNight(night, { socPct: soc, sleeper }));
const seconds = (performance.now() - started) / 1000;
const generatedOn = process.argv[2] ?? new Date().toISOString().slice(0, 10);

const page = nightsReport({ setup, charges: CHARGES, outcomes, generatedOn });
const out = fileURLToPath(new URL('../../../docs/results/storm-nights.md', import.meta.url));
mkdirSync(fileURLToPath(new URL('../../../docs/results/', import.meta.url)), { recursive: true });
writeFileSync(out, page);
console.log(`${String(outcomes.length)} night runs in ${seconds.toFixed(1)} s; wrote docs/results/storm-nights.md`);
