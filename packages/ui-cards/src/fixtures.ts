import { ErrorEnvelopeSchema, PlanSchema, SafeRoomStatusSchema, type ErrorEnvelope, type Plan, type SafeRoomStatus } from '@cold-reserve/contracts';
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
  // plan_comfort always fills the guard's SOC floor: 6 kWh of 13.8 kWh usable.
  plan.reserveFloorSocPct = 43;
  plan.gridAvailable = true;
  plan.forecastConfidence = 'medium';
  plan.confidenceReason = 'Afternoon clouds possible; the weather models disagree after 15:00.';
  return PlanSchema.parse(plan);
}

/** Storm: the grid is measured down, the reserve becomes the budget, so there is no floor. */
export function stormPlan(): Plan {
  const plan: Partial<Plan> = { ...hotDayPlan(), gridAvailable: false };
  delete plan.reserveFloorSocPct;
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

/**
 * A last resort (#160): the night limit cannot be held, so the plan says honestly until when the safe room
 * stays within its limits and how warm it gets after that. Applied only after a second yes.
 */
export function lastResortPlan(): Plan {
  const plan = examplePlan();
  Object.assign(plan, { id: 'plan_LastResort01', steps: hotDayPlan().steps, reserveFloorSocPct: 43, gridAvailable: true });
  plan.guarantees = plan.guarantees.map((g) => (g.id === 'safe_room_comfort' ? { ...g, ok: false, reason: 'Above the 24 °C night limit from 22:00.' } : g));
  plan.lastResort = {
    safeUntil: '2026-07-15T22:00:00+02:00',
    safeHours: 7,
    limitedBy: 'temperature',
    comfortLimitC: 24,
    worstC: 26.1,
    worstAt: '2026-07-16T03:00:00+02:00',
    actions: ['close_curtains', 'drink_water'],
  };
  plan.warnings = [{ code: 'last_resort_plan', message: 'Last resort: within its limits until 22:00, then up to 26.1 °C by 03:00.' }];
  return PlanSchema.parse(plan);
}

/**
 * The guard refuses a plan the model proposed (#186): 21 °C in every room is more than the inverter gives on
 * grid. The refusal carries the whole verdict, so the receipt shows all five rows.
 */
export function inverterRefusal(): ErrorEnvelope {
  const guarantees = rejectedPlan().guarantees.map((g) =>
    g.id === 'inverter_limit' ? { ...g, reason: 'Peak load 8.0 kW is above the 6.0 kW the inverter delivers on grid.', measured: 8000, limit: 6000, nearestAllowed: 6000 } : g,
  );
  return ErrorEnvelopeSchema.parse({
    code: 'inverter_limit_exceeded',
    category: 'guard_rejection',
    message: 'Peak load 8.0 kW is above the 6.0 kW the inverter delivers on grid. Nearest allowed: 6000 W. A plan that holds: Balanced until 7:00 AM.',
    retryable: false,
    // The plan the planner would accept instead (#186): Balanced until the morning.
    details: { guarantee: 'inverter_limit', measured: 8000, limit: 6000, nearestAllowed: 6000, unit: 'W', guarantees, alternative: { level: 'balanced', until: '2026-07-16T07:00:00+02:00' } },
  });
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

/** The safe room during the storm-blackout scene: grandpa in bedroom 1, Essential, grid down. */
export function safeRoomInStorm(): SafeRoomStatus {
  return SafeRoomStatusSchema.parse({
    safeRoomId: 'bedroom-1',
    tempC: 26.8,
    humidityPct: 55,
    occupantRoles: ['grandpa'],
    level: 'essential',
    levelReason: 'storm',
    safeHours: 10.4,
    safeUntil: '2026-07-18T06:40:00+02:00',
    stormPhase: 'active',
    origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated', scenario: 'storm-blackout' },
    homeLink: 'ok',
  });
}

/** The same room on an ordinary evening: no storm, the person's chosen comfort. */
export function safeRoomCalm(): SafeRoomStatus {
  const status: Partial<SafeRoomStatus> = { ...safeRoomInStorm(), level: 'comfort', levelReason: 'user_choice' };
  delete status.stormPhase;
  return SafeRoomStatusSchema.parse(status);
}
