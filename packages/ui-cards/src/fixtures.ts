import { ErrorEnvelopeSchema, PlanSchema, SafeRoomStatusSchema, type ErrorEnvelope, type LocationId, type Plan, type SafeRoomStatus } from '@cold-reserve/contracts';
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

/**
 * An ordinary sunny afternoon (#203, #227; video scene 2a): the solar surplus stays at home instead of going to
 * the grid, the safe room first, then the occupied room furthest above its target.
 */
export function surplusPlan(): Plan {
  return PlanSchema.parse({
    ...hotDayPlan(),
    surplus: {
      from: '2026-07-15T12:00:00+02:00',
      to: '2026-07-15T16:00:00+02:00',
      keptKWh: 2.4,
      comfortC: 24,
      rooms: [
        { roomId: 'bedroom-1', setpointC: 24, reason: 'safe_room', aboveTargetK: 0.8 },
        { roomId: 'living', setpointC: 25, reason: 'occupied', aboveTargetK: -0.4 },
      ],
    },
    // With the battery full the sun keeps exporting after the cooling (#219): a load that fits, advice only.
    householdTip: { load: 'washing', cycle: 'eco', windowFrom: '2026-07-15T15:10:00+02:00', windowTo: '2026-07-15T19:00:00+02:00', probable: false },
  });
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
    actions: ['close_curtains', 'drink_water', 'fan_below_35c'],
  };
  plan.warnings = [{ code: 'last_resort_plan', message: 'Last resort: within its limits until 22:00, then up to 26.1 °C by 03:00.' }];
  return PlanSchema.parse(plan);
}

/**
 * A last resort where the battery runs out first (#364): at 03:05, and the room then holds the 24 °C night limit
 * until about 06:00 before it warms up to 26.1 °C by 07:00. With the home's place when given (#376).
 */
export function lastResortBatteryPlan(place?: LocationId): Plan {
  return PlanSchema.parse({
    ...lastResortPlan(),
    lastResort: {
      safeUntil: '2026-07-16T03:05:00+02:00',
      safeHours: 13.08,
      limitedBy: 'battery',
      comfortLimitC: 24,
      worstC: 26.1,
      worstAt: '2026-07-16T07:00:00+02:00',
      limitCrossedAt: '2026-07-16T06:00:00+02:00',
      limitCrossedC: 24,
      actions: ['close_curtains', 'drink_water', 'fan_below_35c'],
      ...(place === undefined ? {} : { place }),
    },
    warnings: [{ code: 'last_resort_plan', message: 'No plan keeps the Bedroom within its limits until the next recharge: within them until about 06:00, the battery until 03:05; then it warms up.' }],
  });
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
    message: 'Peak load 8.0 kW is above the 6.0 kW the inverter delivers on grid. Nearest allowed: 6000 W.',
    retryable: false,
    details: { guarantee: 'inverter_limit', measured: 8000, limit: 6000, nearestAllowed: 6000, unit: 'W', guarantees },
  });
}

/**
 * The guard refuses a plan that would spend the storm reserve on comfort (scene 2b of the video): cooling the
 * living room all afternoon too takes the battery to 34 %, below the 43 % floor that keeps 6 kWh for a storm.
 * The texts are the guard's own (constraints.ts, rejection.ts), so the card says what the real guard would say.
 */
export function stormReserveRefusal(): ErrorEnvelope {
  const reason = 'The plan takes the battery to 34 %, below the 43 % kept for a storm (6.0 kWh).';
  const guarantees = hotDayPlan().guarantees.map((g) =>
    g.id === 'storm_reserve' ? { id: g.id, ok: false, reason, measured: 34, limit: 43, nearestAllowed: 43, unit: '%' as const } : g,
  );
  return ErrorEnvelopeSchema.parse({
    code: 'storm_reserve_violated',
    category: 'guard_rejection',
    message: `${reason} Nearest allowed: 43 %.`,
    retryable: false,
    details: { guarantee: 'storm_reserve', measured: 34, limit: 43, nearestAllowed: 43, unit: '%', guarantees },
  });
}

/** The model proposed too much and the guard refused it (#202): the answer is the planner's own plan that holds. */
export function planThatHolds(): Plan {
  return PlanSchema.parse({ ...hotDayPlan(), refusedProposal: { code: 'storm_reserve_violated', message: stormReserveRefusal().message } });
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

/** #271: the demo home's grandpa by his fictional name, Leo, at night with the room above the 24 °C night limit. */
export function safeRoomAboveNightLimit(): SafeRoomStatus {
  return SafeRoomStatusSchema.parse({
    ...safeRoomCalm(),
    tempC: 27,
    people: [{ role: 'grandpa', name: 'Leo' }],
    limitNow: { limitC: 24, kind: 'night' },
  });
}

/**
 * #364: the storm at 20:00 with a low battery: it runs out at 03:05 and the room then holds the 24 °C night limit until
 * about 06:00 (the storm-blackout sandbox at hour 4 with 22 %, pinned in the mcp-server agreement test).
 */
export function safeRoomBatteryFirst(): SafeRoomStatus {
  return SafeRoomStatusSchema.parse({
    ...safeRoomInStorm(),
    tempC: 23.8,
    safeHours: 7.08,
    safeUntil: '2026-07-18T03:05:00+02:00',
    withinLimits: { until: '2026-07-18T06:00:00+02:00', limitC: 24 },
  });
}
