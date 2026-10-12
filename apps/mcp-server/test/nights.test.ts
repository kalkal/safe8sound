import { builtInMonth, parseMonth, type Month } from '@cold-reserve/source-simulator';
import { describe, expect, it } from 'vitest';
import { BERYL_NIGHT_DATE, berylNight, hottestNights, monthNight, nightsReport, runNight, studySetup, type NightOutcome, type Sleeper } from '../scripts/nights-study.js';

// The hottest-nights study (#331): the selection rule on made-up months, and two real nights run end to end
// through plan_comfort and the counterfactual, twice, with the same numbers.

/** A made-up July: every hour at `base`, with the given nights (by start date) warmer between 22:00 and 07:00. */
function month(base: number, warm: Record<string, number> = {}): Month {
  const real = builtInMonth('turin');
  const nightOf = (time: string): string | undefined => {
    const [date = '', clock = ''] = time.split('T');
    const hour = Number(clock.slice(0, 2));
    if (hour >= 22) return date;
    if (hour >= 7) return undefined;
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const made = parseMonth({
    ...real,
    hourly: real.hourly.map((h) => {
      const night = nightOf(h.time);
      return { ...h, tempOutC: base + (night === undefined ? 0 : (warm[night] ?? 0)) };
    }),
  });
  if (!made.ok) throw new Error(made.error.message);
  return made.value;
}

const WINDOW = { windowStartHour: 22, windowEndHour: 7 };

describe('the hottest nights of a month', () => {
  it('picks the nights with the highest mean temperature from 22:00 to 07:00, hottest first', () => {
    const picked = hottestNights(month(20, { '2024-07-10': 5, '2024-07-03': 8, '2024-07-21': 2 }), 2, WINDOW);
    expect(picked).toEqual([
      { date: '2024-07-03', meanTempC: 28 },
      { date: '2024-07-10', meanTempC: 25 },
    ]);
  });

  it('breaks ties with the earliest night', () => {
    const picked = hottestNights(month(20, { '2024-07-12': 4, '2024-07-05': 4, '2024-07-30': 4 }), 2, WINDOW);
    expect(picked.map((n) => n.date)).toEqual(['2024-07-05', '2024-07-12']);
  });

  it('leaves out the last night, whose morning is in the next month', () => {
    const picked = hottestNights(month(20, { '2024-07-31': 9 }), 1, WINDOW);
    expect(picked[0]?.date).not.toBe('2024-07-31');
  });

  it('gives the night and the next morning in local hours, from 22:00', () => {
    const night = monthNight(builtInMonth('houston'), '2024-07-07', 14);
    expect(night).toMatchObject({ placeId: 'houston', date: '2024-07-07', tz: 'America/Chicago' });
    expect(night.hourly).toHaveLength(14);
    expect(night.hourly[0]).toEqual(builtInMonth('houston').hourly.find((h) => h.time === '2024-07-07T22:00'));
  });

  it('takes the Beryl night from the Houston month: the night of 8-9 July 2024, after the landfall', () => {
    const houston = builtInMonth('houston');
    const beryl = berylNight(houston, 14);
    expect(beryl).toMatchObject({ placeId: 'houston', date: BERYL_NIGHT_DATE, beryl: true });
    expect(BERYL_NIGHT_DATE).toBe('2024-07-08');
    expect(beryl.hourly).toEqual(monthNight(houston, '2024-07-08', 14).hourly);
  });
});

describe('two nights, plan vs no plan, both sleepers (deterministic)', () => {
  const setup = studySetup();
  const nights = [monthNight(builtInMonth('turin'), '2024-07-30', 14), berylNight(builtInMonth('houston'), 14)];
  const sleepers: Sleeper[] = ['adult', 'older'];
  const runAll = () => Promise.all(sleepers.flatMap((sleeper) => nights.map((n) => runNight(n, { socPct: 60, sleeper }))));

  it('measures the whole night window with the threshold of who sleeps there, from config', async () => {
    const outcomes = await runAll();
    expect(setup.thresholdC).toEqual({ adult: 26, older: 24 });
    for (const o of outcomes) {
      expect(o.thresholdC).toBe(setup.thresholdC[o.sleeper]);
      expect(o.windowHours).toBe(9);
      for (const line of [o.plan, o.noPlan]) {
        expect(line.hoursAtOrBelow).toBeGreaterThanOrEqual(0);
        expect(line.hoursAtOrBelow).toBeLessThanOrEqual(9);
        // The peak is read inside the window only: a line kept all night never peaks above the threshold.
        if (line.hoursAtOrBelow === 9) expect(line.peakTempC).toBeLessThanOrEqual(o.thresholdC);
      }
    }
  });

  it('gives the same numbers and the same report on a second run', async () => {
    const first: NightOutcome[] = await runAll();
    const second: NightOutcome[] = await runAll();
    expect(second).toEqual(first);
    const report = (outcomes: NightOutcome[]) => nightsReport({ setup, charges: [60], outcomes, generatedOn: '2026-10-11' });
    expect(report(second)).toBe(report(first));
    const page = report(first);
    expect(page).toContain('not a medical outcome');
    expect(page).toContain('8-9 July 2024');
    expect(page).not.toContain('7-8 July');
    expect(page).toContain('night threshold 26 °C (78.8 °F)');
    expect(page).toContain('night threshold 24 °C (75.2 °F)');
    expect(page).toContain(`${String(setup.batteryUsableKWh)} kWh usable battery`);
    // Every charge where a line loses a night gets its own reading, with both lines' totals.
    expect(page).toContain('With one older person in the safe room (night threshold 24 °C (75.2 °F)), battery at 60 %: the plan keeps');
    expect(page).not.toContain('no plan holds every guarantee');
    expect(page).toContain(`the guard's own night-recovery target, which asks for at least ${String(setup.requiredHours)} of these hours`);
  });
});
