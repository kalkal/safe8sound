import { DATA_GROUPS, epochMs, isFullyLive, type ApplyPlanOutput, type CounterfactualLine, type DataOrigin, type LevelStep, type Plan, type ReserveOutlook } from '@cold-reserve/contracts';
import { localIso, localTimeText } from '@cold-reserve/core';

// The text content of each tool result. The agent (Strands) reads only this text, not structuredContent
// (F7 finding): every number and fact the model may say is here. The JSON is for the cards and clients.

const one = (x: number) => x.toFixed(1);

/** "live data", or which groups are simulated (simulated data is never presented as real, plan §9.4). */
function dataText(o: DataOrigin): string {
  if (isFullyLive(o)) return 'live data';
  const simulated = DATA_GROUPS.filter((g) => o[g] === 'simulated').join(', ');
  return `simulated data (${simulated}${o.scenario === undefined ? '' : `, scenario ${o.scenario}`})`;
}

/** Each room's first setting in the plan, in time order. */
/** What the plan does in each room, by room label (CE-13): never an internal id. */
function roomSettings(p: Plan, names: Readonly<Record<string, string>> | undefined): string {
  const first = new Map<string, Plan['steps'][number]>();
  for (const s of [...p.steps].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) if (!first.has(s.roomId)) first.set(s.roomId, s);
  if (first.size === 0) return 'no room is run';
  return [...first.values()]
    .map((s) => `${names?.[s.roomId] ?? 'a room'}: ${s.hvacMode === 'off' ? 'off' : `${s.hvacMode} at ${String(s.setpointC)} °C`}${s.fanOn ? ', fan on' : ''}`)
    .join('; ');
}

function rungText(r: LevelStep): string {
  const offset = `${r.setpointOffsetK >= 0 ? '+' : ''}${String(r.setpointOffsetK)} K`;
  const rooms = r.roomIds.length > 0 ? r.roomIds.join(', ') : 'no rooms';
  return `${r.level}: setpoint ${offset}, ${r.preferredModes.join(' or ')}, fans ${r.fansOn ? 'on' : 'off'}, ${rooms}`;
}

function lineText(l: CounterfactualLine, timeZone: string): string {
  return `${String(l.peakTempC)} °C at ${localTimeText(localIso(Date.parse(l.peakAt), timeZone))} (${one(l.heatIndexDegreeHours)} heat-index degree-hours, ${one(l.hoursAtOrBelowThreshold)} night hours at or below the threshold)`;
}

/** What the plan text needs besides the plan: the night window (guard config). */
export interface PlanSummaryOptions {
  readonly nightWindowHours: number;
  /** Wall-clock hours of the night window, to name the night limit of a last resort (#160). */
  readonly nightStartHour: number;
  readonly nightEndHour: number;
  /** The home's time zone: every time in the text is its clock time, at its own date (daylight saving). */
  readonly timeZone: string;
  /** Room labels by id, for the sentences a person hears (CE-13): never an internal id. */
  readonly roomNames?: Readonly<Record<string, string>>;
}

const SURPLUS_REASON = { safe_room: 'safe room', occupied: 'occupied', occupied_tonight: 'slept in tonight' } as const;

/** Where the solar surplus went (#203), in order, by room name, with every number (F7): the scene reads alone. */
function surplusText(s: NonNullable<Plan['surplus']>, opts: PlanSummaryOptions): string {
  const rooms = s.rooms.map((r, i) => {
    const name = opts.roomNames?.[r.roomId] ?? 'a room';
    const side = r.aboveTargetK >= 0 ? 'above' : 'below';
    return `${String(i + 1)}) ${name} (${SURPLUS_REASON[r.reason]}), cooled to ${String(r.setpointC)} °C, now ${Math.abs(r.aboveTargetK).toFixed(1)} °C ${side} target`;
  });
  return (
    `Solar surplus from ${localTimeText(s.from)} to ${localTimeText(s.to)}: ${s.keptKWh.toFixed(1)} kWh kept at home instead of exported to the grid. ` +
    `Where it went, in order: ${rooms.join('; ')}.`
  );
}

/** The wall-clock hour of a time already in the home's zone (localIso), read from the text itself. */
function wallHour(iso: string): number {
  const m = /T(\d\d):(\d\d)/.exec(iso);
  return m === null ? Number.NaN : Number(m[1]) + Number(m[2]) / 60;
}

const inNight = (hour: number, o: PlanSummaryOptions) =>
  o.nightStartHour > o.nightEndHour ? hour >= o.nightStartHour || hour < o.nightEndHour : hour >= o.nightStartHour && hour < o.nightEndHour;

/** The window of a last resort (#160), every number of it, never a claim about the time before safeUntil. */
function windowText(lr: NonNullable<Plan['lastResort']>, opts: PlanSummaryOptions): string | undefined {
  if (lr.comfortLimitC === undefined || lr.worstC === undefined || lr.worstAt === undefined) return undefined;
  // The room has gone past the limit (contract): below it is the heating season.
  const heating = lr.worstC < lr.comfortLimitC;
  const until = localTimeText(lr.safeUntil);
  const by = localTimeText(lr.worstAt);
  // The worst point is the end of the safe hours itself: "at" that time, never "up to … by" it.
  const atEnd = epochMs(lr.worstAt) === epochMs(lr.safeUntil);
  const temp = `${String(lr.worstC)} °C`;
  // The limit came down at safeUntil with the room above it (decided by plan_comfort from the data, #166).
  if (lr.loweredLimitC !== undefined) {
    const head = `From ${until} the limit is ${String(lr.loweredLimitC)} °C and the safe room is above it`;
    return atEnd ? `${head}: at ${until} it is at ${temp}.` : `${head}, up to ${temp} by ${by}.`;
  }
  const limit = `${String(lr.comfortLimitC)} °C${!heating && inNight(wallHour(lr.worstAt), opts) ? ' night' : ''} limit`;
  const then = atEnd
    ? `at ${until} the safe room is at ${temp}, past its ${limit}.`
    : `the safe room then goes ${heating ? 'down' : 'up'} to ${temp} by ${by}, past its ${limit}.`;
  return lr.limitedBy === 'battery' ? `The battery lasts until ${until}; ${then}` : `Safe until ${until}; ${then}`;
}

export function planSummary(p: Plan, opts: PlanSummaryOptions): string {
  const level = p.steps[0]?.level ?? p.ladder[0]?.level ?? 'comfort';
  const commanded = p.advisoryOnly ? 'advice only, nothing is commanded' : 'nothing changes until apply_plan';
  const lr = p.lastResort;
  // A last resort opens with its honest window (CE-21): the model reads the first sentence first.
  const head =
    lr === undefined
      ? `Proposed plan ${p.id}: ${level} level until ${localTimeText(p.horizonAt)}`
      : lr.limitedBy === 'battery'
        ? `Proposed last-resort plan ${p.id}: the safe room alone, until the battery runs out at ${localTimeText(lr.safeUntil)}`
        : `Proposed last-resort plan ${p.id}: the safe room alone, within its limits until ${localTimeText(lr.safeUntil)}`;
  // A refused proposal (#202): the first words say so and that this plan holds, so the model offers it at once.
  const refused =
    p.refusedProposal === undefined ? [] : [`The guard refused the proposed setpoint and rooms: ${p.refusedProposal.message} This plan holds instead and is ready to apply.`];
  const parts = [
    ...refused,
    `${head} (${commanded}), built on ${dataText(p.sourceOrigin)}.`,
    `What it does: ${roomSettings(p, opts.roomNames)}.`,
    ...(p.surplus === undefined ? [] : [surplusText(p.surplus, opts)]),
    `Confirming it also allows these steps down if the battery falls behind: ${p.ladder.map(rungText).join('; ')}.`,
    `Guarantees: ${p.guarantees.map((g) => `${g.id} ${g.ok ? 'holds' : 'FAILS'}: ${g.reason}`).join(' ')}`,
    `Storm reserve ${one(p.reserveWh / 1000)} kWh${p.reserveFloorSocPct === undefined ? '' : `: the battery stays at or above ${one(p.reserveFloorSocPct)} % while the grid is up`}.`,
  ];
  const n = p.nightRecovery;
  if (n !== undefined) parts.push(nightText(n, opts));
  for (const w of p.warnings ?? []) parts.push(`Warning: ${w.message}`);
  const c = p.counterfactual;
  if (c !== undefined) {
    const { noPlan, naive, plan } = c.scenarios;
    parts.push(
      `Without the plan the safe room (${c.roomId}) would peak at ${lineText(noPlan, opts.timeZone)}; ` +
        `with the naive plan (air conditioning until the battery dies) at ${lineText(naive, opts.timeZone)}; ` +
        `with this plan at ${lineText(plan, opts.timeZone)}.`,
    );
  }
  const window = p.lastResort === undefined ? undefined : windowText(p.lastResort, opts);
  if (window !== undefined) parts.push(window);
  // What the room does once the battery is empty, said not hidden (#160 acceptance test: up to ~100 % RH on a
  // humid night). The plan's own steps say the season: a heated room gets colder, never warmer.
  if (p.lastResort?.limitedBy === 'battery') {
    const heating = p.goal === 'heat' || p.steps.some((s) => s.hvacMode === 'heat');
    parts.push(`Once the battery runs out the split stops: the safe room gets ${heating ? 'colder' : 'warmer and more humid'}.`);
  }
  // A last resort is applied only with two explicit yeses (#168): the first apply_plan returns what the second needs.
  parts.push(
    p.lastResort === undefined
      ? `Say it to the person and ask to confirm; then call apply_plan with planId ${p.id}.`
      : `Last resort: the safest plan there is, but not every guarantee holds. It can be applied only with two explicit yeses: ` +
          `read the person the risk and until when the safe room is safe (${localTimeText(p.lastResort.safeUntil)}), ask; ` +
          `if they say yes, call apply_plan with planId ${p.id} and ask again with what it returns.`,
  );
  return parts.join(' ');
}

/** The night-recovery line: the hours, the heat budget when it fails, or "not assessable" on a partial night. */
function nightText(n: NonNullable<Plan['nightRecovery']>, opts: PlanSummaryOptions): string {
  const coveredHours = Math.round(((Date.parse(n.window.end) - Date.parse(n.window.start)) / 3_600_000) * 100) / 100;
  const head = `Night recovery (${n.mode})`;
  // A plan that sees only part of the night requires nothing yet: "0.75 of 0 hours" would mislead.
  if (n.requiredHours === 0 && n.status === 'met' && coveredHours < opts.nightWindowHours) {
    return `${head} not assessable yet: the plan covers only ${String(coveredHours)} of the ${String(opts.nightWindowHours)} night hours.`;
  }
  const heat = `the heat would reach ${String(n.heatIndexDegreeHoursAbove26_7)} heat-index degree-hours above 26.7 °C, over the ${String(n.budgetDegreeHours)} allowed`;
  const overBudget = n.heatIndexDegreeHoursAbove26_7 > n.budgetDegreeHours;
  // With no hour required, only the heat budget can fail: say that, not "0.5 of 0 hours".
  if (n.requiredHours === 0 && n.status !== 'met') return `${head} ${n.status}: ${heat}.`;
  const best = n.bestAchievableHours === undefined ? '' : `, best achievable ${String(n.bestAchievableHours)} hours`;
  const hours = `${String(n.achievedHours)} of ${String(n.requiredHours)} hours at or below ${String(n.thresholdC)} °C${best}`;
  return `${head} ${n.status}: ${hours}${overBudget ? `, and ${heat}` : ''}.`;
}

export function applySummary(o: ApplyPlanOutput): string {
  // The first yes to a last resort (#160): nothing applied; the model reads the risk. The second yes is the
  // person's tap on the card (#201): the token is the host's, so the model never reads it, its format or a way to pass it.
  if (o.confirmation !== undefined) {
    const risk = o.plan.warnings?.find((w) => w.code === 'last_resort_plan')?.message ?? 'Not every guarantee holds.';
    return (
      `Not applied yet: this is a last resort. Read the person the risk: ${risk} ` +
      `The second yes is a tap on the card, "Yes, apply it now", before ${localTimeText(o.confirmation.expiresAt)}. ` +
      'Never ask the person for a token or a code, and never make one up.'
    );
  }
  const applied = o.alreadyApplied ? `Plan ${o.plan.id} was already applied.` : `Plan ${o.plan.id} applied${o.advisoryOnly ? ' as advice' : ''}.`;
  const head = o.familyAlert === undefined ? applied : `${applied} ${familyAlertText(o.familyAlert)}`;
  if (!o.advisoryOnly) return head;
  const steps = o.manualInstructions.map((m) => m.text).join('; ');
  return `${head} Nothing is commanded on this home: set it by hand. ${steps}.`;
}

/** How the family alert of a last resort went (#170): said plainly, a failure with what to do now. */
function familyAlertText(a: NonNullable<ApplyPlanOutput['familyAlert']>): string {
  const total = a.sent + a.failed;
  if (total === 0) return 'No family contact is registered, so nobody was alerted.';
  if (a.failed > 0) return `The family alert could not be sent to ${String(a.failed)} of ${String(total)} contacts: call them now.`;
  return `${String(a.sent)} registered family ${a.sent === 1 ? 'contact was' : 'contacts were'} alerted.`;
}

export function outlookSummary(o: ReserveOutlook): string {
  return (
    `On the battery alone: about ${one(o.hoursAtCurrentLevel)} hours at ${o.level} level, or ${one(o.hoursAtEssential)} hours at essential with the same energy; ` +
    `the storm reserve alone gives ${one(o.reserveHoursAtEssential)} hours at essential. As of ${localTimeText(o.ts)} (${dataText(o.origin)}).`
  );
}
