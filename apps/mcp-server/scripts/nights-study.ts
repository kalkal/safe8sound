import { HomeIdSchema, ok, pct, type HomeProfile } from '@cold-reserve/contracts';
import { fixedClock, localIso, memoryLogger, naiveControls, nightMetrics, zonedTimeMs, type ProjectionPoint } from '@cold-reserve/core';
import { buildContext, currentControls, projectFrom, type GuardInput } from '@cold-reserve/guard';
import { createInAppNotifier } from '@cold-reserve/notifier-inapp';
import { SimulatorSource, builtInPlace, defaultSimParams, demoProfile, parseScenario, profileAtPlace, rawScript, type Month } from '@cold-reserve/source-simulator';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { loadComfortPlanConfig } from '../src/comfort-plan-config.js';
import type { ComfortPlanDeps } from '../src/modules/comfort-plan/deps.js';
import { guardFrame, planComfort } from '../src/modules/comfort-plan/plan-comfort.js';
import { defaultPreferencesFor, loadPreferencesConfig, preferencesConfigFile } from '../src/preferences-config.js';

// The hottest storm nights (#331): what the plan is worth on real hot nights of July 2024 with the grid down,
// against "no plan" (the AC at the comfort setpoint until the battery dies, no pacing and no charge held back on purpose). Each
// night runs plan_comfort itself at 22:00 with the grid down; both lines are then projected again from the same
// snapshot, forecast and physics the guard used, and checked against the plan's own counterfactual. No network,
// no model, no clock: the same inputs always give the same numbers.

/** The selection rule, fixed before any night was run. */
export const SELECTION_RULE =
  'The nights of July 2024 with the highest mean outdoor temperature over the hours 22:00-07:00 local; ties go to the earliest night. The night of 31 July is left out: its morning is in August, outside the data.';

/**
 * The Hurricane Beryl night in Houston, by name: the night from 22:00 on 8 July 2024. Beryl made landfall in Texas
 * around 04:00 on 8 July and about 2.2 million CenterPoint customers were without power that day, so the night of
 * 8-9 July is the first whole night with the grid down (on 7-8 July the grid was mostly still up). Sources:
 * Wikipedia, "Effects of Hurricane Beryl in Texas"; S&P Global, 8 July 2024.
 */
export const BERYL_NIGHT_DATE = '2024-07-08';

/** A place of the study (Turin and Houston have a July 2024 month file). */
export type CityId = Month['id'];

/** Who sleeps in the safe room: one adult (the standard night threshold) or one older person (the elderly one). */
export type Sleeper = 'adult' | 'older';

/** One night to run: its local start date, its zone and its hours from 22:00 of that date. */
export interface Night {
  readonly placeId: CityId;
  readonly date: string;
  readonly tz: string;
  readonly hourly: readonly { readonly tempOutC: number; readonly humidityOutPct: number; readonly irradianceWm2: number }[];
  /** Mean outdoor temperature over the night window, °C. */
  readonly meanTempC: number;
  readonly beryl?: true;
}

/** One line over the night window, in the safe room. */
export interface LineOutcome {
  readonly hoursAtOrBelow: number;
  /** The highest safe-room temperature inside the night window (not over the whole projection). */
  readonly peakTempC: number;
  readonly heatIndexDegreeHours: number;
  /** The battery at the end of the night window. */
  readonly socAtEndPct: number;
}

export interface NightOutcome {
  readonly placeId: CityId;
  readonly date: string;
  readonly meanTempC: number;
  readonly beryl: boolean;
  readonly sleeper: Sleeper;
  readonly socPct: number;
  readonly thresholdC: number;
  readonly windowHours: number;
  /** The plan Safe-8-Sound proposes holds every guarantee; otherwise it is the last resort. */
  readonly planKind: 'guaranteed' | 'last_resort';
  /** The guarantees the plan does not hold (empty when every guarantee holds). */
  readonly failedGuarantees: readonly string[];
  readonly plan: LineOutcome;
  readonly noPlan: LineOutcome;
}

export interface NightWindow {
  readonly windowStartHour: number;
  readonly windowEndHour: number;
}

/** The hours of the study day: the night window, then the morning up to the end of the projection. */
export const NIGHT_HOURS = 14;

const HOUR_MS = 3_600_000;
const round1 = (x: number) => Math.round(x * 10) / 10 + 0;
const round2 = (x: number) => Math.round(x * 100) / 100 + 0;
const windowLength = (w: NightWindow) => (w.windowEndHour - w.windowStartHour + 24) % 24;
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** The `count` nights of the month with the highest mean temperature over the window; ties: the earliest. */
export function hottestNights(month: Month, count: number, window: NightWindow): { date: string; meanTempC: number }[] {
  const length = windowLength(window);
  const nights: { date: string; meanTempC: number }[] = [];
  month.hourly.forEach((h, i) => {
    if (!h.time.endsWith(`T${hh(window.windowStartHour)}`)) return;
    const hours = month.hourly.slice(i, i + length);
    if (hours.length < length) return;
    nights.push({ date: h.time.slice(0, 10), meanTempC: round2(hours.reduce((s, x) => s + x.tempOutC, 0) / length) });
  });
  return nights.sort((a, b) => b.meanTempC - a.meanTempC || a.date.localeCompare(b.date)).slice(0, count);
}

/** A night of the month from 22:00 of `date`, `hours` long. */
export function monthNight(month: Month, date: string, hours: number, window: NightWindow = { windowStartHour: 22, windowEndHour: 7 }): Night {
  const start = month.hourly.findIndex((h) => h.time === `${date}T${hh(window.windowStartHour)}`);
  const hourly = start < 0 ? [] : month.hourly.slice(start, start + hours);
  if (hourly.length !== hours) throw new Error(`The month has no ${String(hours)} hours from the night of ${date}.`);
  return { placeId: month.id, date, tz: month.tz, hourly, meanTempC: meanOver(hourly, window) };
}

/** The Hurricane Beryl night in Houston (BERYL_NIGHT_DATE): the hours of the Houston July 2024 month. */
export function berylNight(month: Month, hours: number, window: NightWindow = { windowStartHour: 22, windowEndHour: 7 }): Night {
  if (month.id !== 'houston') throw new Error('The Beryl night is in Houston.');
  return { ...monthNight(month, BERYL_NIGHT_DATE, hours, window), beryl: true };
}

const meanOver = (hourly: Night['hourly'], window: NightWindow): number => {
  const night = hourly.slice(0, windowLength(window));
  return round2(night.reduce((s, h) => s + h.tempOutC, 0) / night.length);
};

const DEMO = HomeIdSchema.parse('demo');

/** What the page says about the home and the rules, read from config (never typed into the text). */
export interface StudySetup {
  readonly window: NightWindow;
  readonly batteryUsableKWh: number;
  readonly epsContinuousKva: number;
  /** The rooms at 22:00 (the storm script's starting rooms), °C. */
  readonly roomsFromC: number;
  readonly roomsToC: number;
  /** The comfort setpoint "no plan" cools to, °C. */
  readonly comfortSetpointC: number;
  /** The battery's hardware floor, %: an empty battery. */
  readonly batteryFloorPct: number;
  /** The guard's own night-recovery target: at least this many window hours at or below the threshold. */
  readonly requiredHours: number;
  readonly thresholdC: Readonly<Record<Sleeper, number>>;
}

function loadConfigs() {
  const configs = loadComfortPlanConfig();
  if (!configs.ok) throw new Error(configs.error.message);
  const prefsConfig = loadPreferencesConfig(preferencesConfigFile());
  if (!prefsConfig.ok) throw new Error(prefsConfig.error.message);
  return { ...configs.value, prefs: prefsConfig.value };
}

function homeAt(placeId: CityId) {
  const { prefs } = loadConfigs();
  const profile: HomeProfile = { ...profileAtPlace(demoProfile(), builtInPlace(placeId)), homeId: DEMO };
  const preferences = defaultPreferencesFor(prefs, profile, DEMO);
  if (!preferences.ok) throw new Error(preferences.error.message);
  return { profile, preferences: preferences.value };
}

const stormRooms = () => (rawScript('storm-blackout') as { initial: { rooms: { tempC: number }[] } }).initial.rooms;

export function studySetup(): StudySetup {
  const { guard } = loadConfigs();
  const { profile, preferences } = homeAt('turin');
  const temps = stormRooms().map((r) => r.tempC);
  const t = guard.nightRecovery.thresholdC;
  return {
    window: { windowStartHour: guard.nightRecovery.windowStartHour, windowEndHour: guard.nightRecovery.windowEndHour },
    batteryUsableKWh: round1(profile.battery.usableWh / 1000),
    epsContinuousKva: round1(profile.eps.continuousVa / 1000),
    roomsFromC: Math.min(...temps),
    roomsToC: Math.max(...temps),
    comfortSetpointC: preferences.comfortC.cooling,
    batteryFloorPct: profile.battery.minSocHwPct,
    requiredHours: guard.nightRecovery.requiredHours,
    thresholdC: { adult: t.standard, older: t.elderly },
  };
}

/**
 * Runs one night: the home at 22:00 with the grid down until 07:00 and the battery at `socPct`, plan_comfort with
 * the goal "cool", and both lines over the night window. The safe room holds one adult (the standard night
 * threshold) or one older person (the elderly threshold, with the guard's older-person rules); its starting rooms
 * are the storm script's.
 */
export async function runNight(night: Night, opts: { socPct: number; sleeper: Sleeper }): Promise<NightOutcome> {
  const { comfort, guard } = loadConfigs();
  const { profile, preferences } = homeAt(night.placeId);
  const olderRole = comfort.elderlyRoles[0];
  if (opts.sleeper === 'older' && olderRole === undefined) throw new Error('The config names no older-person role.');
  const roles = opts.sleeper === 'older' && olderRole !== undefined ? [olderRole] : ['adult'];

  const window = guard.nightRecovery;
  const startMs = zonedTimeMs(night.date, window.windowStartHour, night.tz);
  const windowEndMs = startMs + windowLength(window) * HOUR_MS;
  const scenario = parseScenario(
    nightScenario(night, { startMs, startHour: window.windowStartHour, socPct: opts.socPct, outageH: windowLength(window), safeRoomId: preferences.safeRoomId, roles, baseLoadW: guard.projection.baseLoadWByLocalHour }),
    profile,
  );
  if (!scenario.ok) throw new Error(scenario.error.message);
  const params = defaultSimParams();
  const sim = new SimulatorSource({ profile, scenario: scenario.value, params, clock: fixedClock(startMs) });
  // One snapshot and one forecast, for plan_comfort and for the lines projected again below.
  const snapshot = sim.snapshotAt(startMs);
  const forecast = sim.forecast();
  const wall = fixedClock(startMs);
  const storeFor = memoryStateStoreFactory({ backing: createMemoryBacking(), clock: wall });
  const phone = createInAppNotifier({ storeFor, maxPerHome: 20 });
  if (!phone.ok) throw new Error(phone.error.message);
  let n = 0;
  const deps: ComfortPlanDeps = {
    homes: (h) => (h === DEMO ? { source: { snapshot: () => Promise.resolve(ok(snapshot)) }, forecast: () => forecast, profile, readOnly: false } : undefined),
    storeFor,
    preferencesFor: () => Promise.resolve(ok(preferences)),
    clock: wall,
    model: params,
    guard,
    config: comfort,
    logger: memoryLogger(),
    notifier: phone.value.notifier,
    newPlanId: () => `plan_nights${String(++n).padStart(9, '0')}`,
  };
  const label = `${night.placeId} ${night.date} ${opts.sleeper} ${String(opts.socPct)} %`;
  const planned = await planComfort(deps, { goal: 'cool' }, { correlationId: 'nights-study', clientId: 'nights-study', homeId: DEMO });
  if (!planned.ok) throw new Error(`${label}: ${planned.error.message}`);
  const plan = planned.value;
  const counterfactual = plan.counterfactual?.scenarios;
  if (counterfactual === undefined) throw new Error(`${label}: the plan has no counterfactual.`);
  if (Date.parse(plan.horizonAt) < windowEndMs) throw new Error(`${label}: the plan ends before the night window does.`);

  // The plan's counterfactual measures its peak over the whole projection: the study wants it inside the night
  // window. Both lines are projected again exactly as the counterfactual does (same input, controls and floor).
  const frame = guardFrame({ config: comfort }, plan.goal, { snapshot, forecast, preferences });
  const input: GuardInput = { plan: { horizonAt: plan.horizonAt, steps: plan.steps, ladder: plan.ladder }, snapshot, forecast, profile, preferences, model: params, config: guard, ...frame };
  const context = buildContext(input);
  const running = currentControls(snapshot).filter((c) => c.hvac !== undefined && c.hvac.mode !== 'off');
  const occupied = snapshot.rooms.filter((r) => r.occupants.length > 0).map((r) => r.id);
  const naiveNow = running.length > 0 ? currentControls(snapshot) : naiveControls(profile, { occupied, safeRoomId: preferences.safeRoomId, setpointC: preferences.comfortC.cooling });
  const naive = projectFrom(input, () => naiveNow, { toMs: context.horizonMs, dischargeFloorPct: pct(profile.battery.minSocHwPct) });

  const thresholdC = window.thresholdC[frame.nightRecoveryMode];
  const line = (points: readonly ProjectionPoint[], expected: { hoursAtOrBelowThreshold: number; heatIndexDegreeHours: number }, name: string): LineOutcome => {
    const metrics = nightMetrics(points, { roomId: preferences.safeRoomId, tz: night.tz, stepMinutes: guard.projection.stepMinutes, thresholdC, config: window });
    if (metrics === undefined || round2(metrics.achievedHours) !== expected.hoursAtOrBelowThreshold) {
      throw new Error(`${label}: the ${name} line projected again does not match the plan's counterfactual.`);
    }
    const inWindow = points.filter((p) => p.ms >= startMs && p.ms < windowEndMs);
    const temps = inWindow.map((p) => p.rooms.find((r) => r.id === preferences.safeRoomId)?.tempC ?? Number.NaN);
    const end = points.find((p) => p.ms >= windowEndMs);
    if (temps.length === 0 || temps.some(Number.isNaN) || end === undefined) throw new Error(`${label}: the ${name} line does not cover the night window.`);
    return { hoursAtOrBelow: expected.hoursAtOrBelowThreshold, peakTempC: round1(Math.max(...temps)), heatIndexDegreeHours: expected.heatIndexDegreeHours, socAtEndPct: Math.round(end.socPct) };
  };
  return {
    placeId: night.placeId,
    date: night.date,
    meanTempC: night.meanTempC,
    beryl: night.beryl === true,
    sleeper: opts.sleeper,
    socPct: opts.socPct,
    thresholdC,
    windowHours: windowLength(window),
    planKind: plan.lastResort === undefined ? 'guaranteed' : 'last_resort',
    failedGuarantees: plan.guarantees.filter((g) => !g.ok).map((g) => g.id),
    plan: line(context.points, counterfactual.plan, 'plan'),
    noPlan: line(naive, counterfactual.naive, 'no-plan'),
  };
}

/** The night as a raw scenario, for the scenario schema to validate (it creates the branded units). */
function nightScenario(
  night: Night,
  o: { startMs: number; startHour: number; socPct: number; outageH: number; safeRoomId: string; roles: readonly string[]; baseLoadW: readonly number[] },
): unknown {
  return {
    schemaVersion: 1,
    id: 'storm-night',
    version: '1.0.0',
    description: 'A hot night with the grid down from 22:00 to 07:00 (the nights study, #331).',
    startAt: localIso(o.startMs, night.tz),
    durationH: night.hourly.length,
    stepSeconds: 60,
    seed: 20240701,
    simulatedGroups: ['energy', 'rooms', 'weather'],
    initial: { batterySocPct: o.socPct, rooms: stormRooms() },
    hourly: night.hourly.map((h, i) => ({
      tempOutC: h.tempOutC,
      humidityOutPct: h.humidityOutPct,
      irradianceWm2: h.irradianceWm2,
      stormProb: i < o.outageH ? 0.9 : 0.1,
      baseLoadW: o.baseLoadW[(o.startHour + i) % 24] ?? 0,
    })),
    // The study reads no sun times: the irradiance is hourly.
    sun: { sunrise: [], sunset: [] },
    gridOutages: [{ fromH: 0, toH: o.outageH }],
    occupancy: [{ roomId: o.safeRoomId, roles: [...o.roles], fromH: 0, toH: night.hourly.length }],
    hvac: [],
  };
}

// The report.

export interface StudyResults {
  readonly setup: StudySetup;
  readonly charges: readonly number[];
  /** Every run: both sleepers, every charge, every night. */
  readonly outcomes: readonly NightOutcome[];
  readonly generatedOn: string;
}

const SLEEPERS: readonly Sleeper[] = ['adult', 'older'];
const kept = (l: LineOutcome, o: NightOutcome) => l.hoursAtOrBelow >= o.windowHours;
/** The guard's own target, hours only: at least `requiredHours` of the window at or below the threshold. */
const reachesTarget = (l: LineOutcome, s: StudySetup) => l.hoursAtOrBelow >= s.requiredHours;
const guaranteeText = (id: string) => id.replace(/_/g, ' ').replace('safe room', 'safe-room');
const above = (l: LineOutcome, o: NightOutcome) => round2(o.windowHours - l.hoursAtOrBelow);
const toF = (c: number) => round1((c * 9) / 5 + 32);
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(x * 10 === Math.round(x * 10) ? 1 : 2));
const temp = (c: number, f: boolean) => (f ? `${fmt(round1(c))} °C (${fmt(toF(c))} °F)` : `${fmt(round1(c))} °C`);
const range = (xs: readonly number[], unit: string) => {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return lo === hi ? `${fmt(lo)}${unit}` : `${fmt(lo)}-${fmt(hi)}${unit}`;
};
const whoText = (s: Sleeper) => (s === 'adult' ? 'one adult' : 'one older person');
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
/** "8-9 July 2024" for the night from 22:00 on 2024-07-08. */
const nightText = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  const next = new Date(d.getTime() + 24 * HOUR_MS);
  return `${String(d.getUTCDate())}-${DAY_MONTH.format(next)}`;
};
const hottest = (outcomes: readonly NightOutcome[]) => String(new Set(outcomes.map((o) => o.date)).size);
const avoidedOf = (outcomes: readonly NightOutcome[]) => round2(outcomes.reduce((s, o) => s + above(o.noPlan, o) - above(o.plan, o), 0));

function summaryRow(label: string, outcomes: readonly NightOutcome[]): string {
  const keptPlan = outcomes.filter((o) => kept(o.plan, o)).length;
  const keptNo = outcomes.filter((o) => kept(o.noPlan, o)).length;
  return `| ${label} | ${String(keptPlan)} of ${String(outcomes.length)} | ${String(keptNo)} of ${String(outcomes.length)} | ${fmt(avoidedOf(outcomes))} |`;
}

function nightTable(outcomes: readonly NightOutcome[], f: boolean, windowText: string): string[] {
  return [
    `| Night | Mean outdoor ${windowText} | Battery at start | Plan | Hours above, plan | Hours above, no plan | Peak in the window, plan | Peak in the window, no plan | Battery at the end, plan | Battery at the end, no plan |`,
    '|---|---|---|---|---|---|---|---|---|---|',
    ...outcomes.map(
      (o) =>
        `| ${o.date}${o.beryl ? ' (Beryl)' : ''} | ${temp(o.meanTempC, f)} | ${String(o.socPct)} % | ${o.planKind === 'guaranteed' ? 'every guarantee holds' : 'last resort'} | ${fmt(above(o.plan, o))} | ${fmt(above(o.noPlan, o))} | ${temp(o.plan.peakTempC, f)} | ${temp(o.noPlan.peakTempC, f)} | ${String(o.plan.socAtEndPct)} % | ${String(o.noPlan.socAtEndPct)} % |`,
    ),
  ];
}

/** What the numbers say, for one sleeper: every sentence is computed from the runs. */
function readings(r: StudyResults, sleeper: Sleeper): string[] {
  const runs = r.outcomes.filter((o) => o.sleeper === sleeper);
  const thresholdC = r.setup.thresholdC[sleeper];
  const at = (soc: number) => runs.filter((o) => o.socPct === soc);
  const allKept = (soc: number) => at(soc).every((o) => kept(o.plan, o) && kept(o.noPlan, o));
  const sorted = [...r.charges].sort((a, b) => b - a);
  let lowestAllKept: number | undefined;
  for (const soc of sorted) {
    if (!allKept(soc)) break;
    lowestAllKept = soc;
  }
  const who = `With ${whoText(sleeper)} in the safe room (night threshold ${temp(thresholdC, true)})`;
  const end = hh(r.setup.window.windowEndHour);
  const batteryAt = (list: readonly NightOutcome[]) => {
    const planEnd = list.map((o) => o.plan.socAtEndPct);
    const noPlanEnd = list.map((o) => o.noPlan.socAtEndPct);
    return [...planEnd, ...noPlanEnd].every((x) => x <= r.setup.batteryFloorPct)
      ? `both lines end the window at the battery's hardware floor (${String(r.setup.batteryFloorPct)} %)`
      : `the battery is at ${range(planEnd, ' %')} with the plan and ${range(noPlanEnd, ' %')} with no plan`;
  };
  const lines: string[] = [];
  if (lowestAllKept !== undefined) {
    const allKeptCharges = sorted.filter((soc) => soc >= lowestAllKept);
    const ends = allKeptCharges.map((soc) => `from ${String(soc)} % ${batteryAt(at(soc))}`).join('; ');
    lines.push(
      `- ${who}: with a charge of ${String(lowestAllKept)} % or more at the start both lines keep every night, so the plan avoids no hour above the threshold. At ${end}, ${ends}.`,
    );
  }
  for (const soc of sorted) {
    if (lowestAllKept !== undefined && soc >= lowestAllKept) continue;
    const list = at(soc);
    const n = String(list.length);
    const keptPlan = list.filter((o) => kept(o.plan, o)).length;
    const keptNo = list.filter((o) => kept(o.noPlan, o)).length;
    const targetPlan = list.filter((o) => reachesTarget(o.plan, r.setup)).length;
    const targetNo = list.filter((o) => reachesTarget(o.noPlan, r.setup)).length;
    const abovePlan = round2(list.reduce((s, o) => s + above(o.plan, o), 0));
    const aboveNo = round2(list.reduce((s, o) => s + above(o.noPlan, o), 0));
    const diff = round2(aboveNo - abovePlan);
    const compare =
      diff > 0 ? `the plan avoids ${fmt(diff)} of them` : diff < 0 ? `the plan has ${fmt(-diff)} more than no plan` : 'the same with both lines';
    const lastResort = list.filter((o) => o.planKind === 'last_resort');
    const failed = [...new Set(lastResort.flatMap((o) => o.failedGuarantees))].map(guaranteeText);
    const kind =
      lastResort.length === 0
        ? 'Every plan holds every guarantee of the guard'
        : `${String(lastResort.length)} of the ${n} plans are the last resort, because no option holds the ${failed.join(' and ')} ${failed.length === 1 ? 'guarantee' : 'guarantees'}, which the guard checks until the battery can recharge, past the ${end} end of this window`;
    lines.push(
      `- ${who}, battery at ${String(soc)} %: the plan keeps ${String(keptPlan)} of ${n} nights, no plan ${String(keptNo)} of ${n}; the guard's target of ${fmt(r.setup.requiredHours)} hours at or below the threshold is reached on ${String(targetPlan)} of ${n} nights with the plan and ${String(targetNo)} of ${n} with no plan. Hours above the threshold, in total over the nights: ${fmt(abovePlan)} with the plan, ${fmt(aboveNo)} with no plan, so ${compare}. ${kind}. At ${end} ${batteryAt(list)}.`,
    );
  }
  const why: string[] = [];
  if (runs.length > 0 && runs.every((o) => !kept(o.plan, o) && !kept(o.noPlan, o))) {
    if (r.setup.roomsFromC > thresholdC) {
      why.push(`no line keeps a whole night because the rooms are already at ${range([r.setup.roomsFromC, r.setup.roomsToC], ' °C')} at ${hh(r.setup.window.windowStartHour)}, above the threshold, and the safe room needs time to cool`);
    }
    if (r.setup.comfortSetpointC > thresholdC) {
      why.push(`no plan cools only to the comfort setpoint (${temp(r.setup.comfortSetpointC, true)}), above this threshold, so it stays above it all night`);
    }
  }
  if (why.length > 0) lines.push(`- ${who}: ${why.join('; ')}.`);
  return lines;
}

/** The results page: per sleeper, a summary per starting charge, then every night. Deterministic for the same results. */
export function nightsReport(r: StudyResults): string {
  const s = r.setup;
  const start = hh(s.window.windowStartHour);
  const end = hh(s.window.windowEndHour);
  const windowText = `${start}-${end}`;
  const lines = [
    '# Hottest storm nights + Beryl: plan vs no plan',
    '',
    `Issue #331. Generated on ${r.generatedOn} by \`pnpm --filter @cold-reserve/mcp-server nights\`. Deterministic: the same inputs always give these numbers.`,
    '',
    '## What was run',
    '',
    `- **Nights.** Turin and Houston, July 2024 (Open-Meteo historical archive, ERA5; "Weather data by Open-Meteo.com, CC BY 4.0"). Selection rule, written before running: ${SELECTION_RULE} Plus the Hurricane Beryl night in Houston, ${nightText(BERYL_NIGHT_DATE)}, from the same Houston month.`,
    `- **Blackout.** Every night is a separate test with a blackout from ${start} to ${end} local time. For the hottest nights it is **hypothetical**. For Beryl it was real: the hurricane made landfall in Texas early on 8 July 2024 and about 2.2 million CenterPoint customers in the Houston area were without power that day (Wikipedia, "Effects of Hurricane Beryl in Texas"; S&P Global, 8 July 2024), so the night of ${nightText(BERYL_NIGHT_DATE)} is the first whole night with the grid down. Here it is modelled with the same ${windowText} window as the other nights.`,
    `- **The home.** The demo home (${fmt(s.batteryUsableKWh)} kWh usable battery, ${fmt(s.epsContinuousKva)} kVA EPS), its rooms at ${range([s.roomsFromC, s.roomsToC], ' °C')} at ${start}. Starting charge at ${start}: ${r.charges.map((c) => `${String(c)} %`).join(', ')}.`,
    `- **Who sleeps in the safe room.** Every night runs twice: with ${whoText('adult')} (night threshold ${temp(s.thresholdC.adult, true)}) and with ${whoText('older')} (night threshold ${temp(s.thresholdC.older, true)}, and the guard's older-person rules). Both thresholds come from the guard config.`,
    `- **Plan.** What Safe-8-Sound proposes: \`plan_comfort\` with the goal "cool" at ${start}, grid down. When no option holds every guarantee, its answer is the last resort (applied only after an explicit second yes).`,
    `- **No plan.** The AC at the comfort setpoint (${temp(s.comfortSetpointC, true)}) in the safe room and every occupied room as long as the battery lasts: no pacing, and no charge held back on purpose.`,
    `- **Measure.** Both lines are projected with the same snapshot, weather, physics and night measure the guard uses, in the safe room, and checked against the plan's counterfactual. A night is **kept** when the safe room stays at or below the night threshold for all ${String(windowLength(s.window))} hours from ${start} to ${end}. This is stricter than the guard's own night-recovery target, which asks for at least ${fmt(s.requiredHours)} of these hours at or below the threshold (guard config); the readings give both. "Hours above" counts the hours of that window above the threshold. "Peak in the window" is the highest safe-room temperature inside that window only. "Battery at the end" is the charge at ${end}; the hours after ${end} are not measured.`,
    '',
    '> These are comfort-for-sleep measures from a simulation, not a medical outcome.',
    '',
    '## Reading the results',
    '',
    ...SLEEPERS.flatMap((who) => readings(r, who)),
    '',
  ];
  for (const sleeper of SLEEPERS) {
    const runs = r.outcomes.filter((o) => o.sleeper === sleeper);
    const of = (place: CityId, beryl: boolean) => runs.filter((o) => o.placeId === place && o.beryl === beryl);
    const who = whoText(sleeper);
    lines.push(`## ${who.charAt(0).toUpperCase()}${who.slice(1)} in the safe room: night threshold ${temp(s.thresholdC[sleeper], true)}`, '', '### Summary', '');
    for (const soc of r.charges) {
      const at = (list: readonly NightOutcome[]) => list.filter((o) => o.socPct === soc);
      lines.push(
        `#### Battery at ${String(soc)} % at ${start}`,
        '',
        '| Nights | Kept, plan | Kept, no plan | Hours above the threshold avoided by the plan (negative: more hours above with the plan) |',
        '|---|---|---|---|',
        summaryRow(`Turin, ${hottest(of('turin', false))} hottest`, at(of('turin', false))),
        summaryRow(`Houston, ${hottest(of('houston', false))} hottest`, at(of('houston', false))),
        summaryRow('Houston, Beryl', at(of('houston', true))),
        '',
      );
    }
    lines.push('### Every night', '', '#### Turin', '', ...nightTable(of('turin', false), false, windowText), '', '#### Houston (°C and °F)', '', ...nightTable([...of('houston', false), ...of('houston', true)], true, windowText), '');
  }
  return lines.join('\n');
}
