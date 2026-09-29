import { PlanSchema, type Plan } from '@cold-reserve/contracts';
import { examplePlan } from '@cold-reserve/contracts/fixtures';

// Card fixtures, built only from the contract fixtures and parsed by the contract schemas.

type PlanInput = ReturnType<typeof examplePlan>;
type StepInput = PlanInput['steps'][number];

const step = (ts: string, level: StepInput['level'], soc: number, setpointC: number): StepInput => ({
  ts,
  roomId: 'bedroom-1',
  hvacMode: 'cool',
  setpointC,
  fanOn: level !== 'comfort',
  level,
  batteryTargetSocPct: soc,
});

/** Hot day: pre-cool on solar, then Balanced and Saver through the night; Essential is not needed. */
export function hotDayPlan(): Plan {
  const plan = examplePlan();
  plan.steps = [
    step('2026-07-15T15:00:00+02:00', 'comfort', 80, 24),
    step('2026-07-15T18:00:00+02:00', 'comfort', 88, 25),
    step('2026-07-15T19:00:00+02:00', 'balanced', 82, 26),
    step('2026-07-15T23:00:00+02:00', 'saver', 62, 27),
    step('2026-07-16T03:00:00+02:00', 'saver', 52, 27),
    step('2026-07-16T06:40:00+02:00', 'saver', 46, 27),
  ];
  plan.forecastConfidence = 'medium';
  plan.confidenceReason = 'Afternoon clouds possible; the weather models disagree after 15:00.';
  return PlanSchema.parse(plan);
}

/** The guard says no: three splits at once exceed the inverter. */
export function rejectedPlan(): Plan {
  const plan = examplePlan();
  plan.guarantees = plan.guarantees.map((g) =>
    g.id === 'inverter_limit'
      ? { id: g.id, ok: false, reason: 'Three splits at once need 5.4 kW.', measured: 5400, limit: 5000, nearestAllowed: 4800, unit: 'W' as const }
      : g,
  );
  return PlanSchema.parse(plan);
}

/** The real home during the hackathon: advice only, with a warning the voice must say. */
export function advisoryPlan(): Plan {
  const plan = examplePlan();
  plan.advisoryOnly = true;
  plan.sourceOrigin = { energy: 'live', rooms: 'live', weather: 'live' };
  plan.nightRecovery = {
    roomId: 'bedroom-1',
    mode: 'elderly',
    thresholdC: 24,
    window: { start: '2026-07-15T22:00:00+02:00', end: '2026-07-16T07:00:00+02:00' },
    requiredHours: 6,
    achievedHours: 4,
    status: 'infeasible',
    bestAchievableHours: 4,
    heatIndexDegreeHoursAbove26_7: 0,
    budgetDegreeHours: 4,
  };
  plan.warnings = [{ code: 'night_recovery_infeasible', message: 'The bedroom stays at or below 24 °C for 4 of the 6 hours needed tonight.' }];
  return PlanSchema.parse(plan);
}
