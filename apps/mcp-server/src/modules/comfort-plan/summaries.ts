import { DATA_GROUPS, epochMs, formatTemp, isFullyLive, tempGap, type ApplyPlanOutput, type TempUnit, type CounterfactualLine, type DataOrigin, type LevelStep, type Plan, type ReserveOutlook } from '@cold-reserve/contracts';
import { localIso, localTimeText } from '@cold-reserve/core';
import { lastResortAdvice } from '@cold-reserve/i18n';
import { roomTimeLeads } from './family-alert.js';

// The text content of each tool result. The agent (Strands) reads only this text, not structuredContent
// (F7 finding): every number and fact the model may say is here. The JSON is for the cards and clients.

const one = (x: number) => x.toFixed(1);

// Temperatures in the unit the sandbox chose (#306): computed in °C, written with the shared helper of the cards.
const deg = (c: number, unit: TempUnit) => formatTemp(c, unit);
/** A heat-index degree-hour amount (a sum of differences, not an absolute): × 1.8 in °F, to one decimal. */
const degreeHours = (dh: number, unit: TempUnit) => (unit === 'F' ? Math.round(dh * 18) / 10 : dh);
/** An amount against that budget: in °F rounded up to the tenth, never said as equal to a budget it passes (#306 review). */
const heatAmount = (dh: number, unit: TempUnit) => (unit === 'F' ? Math.ceil(Math.round(dh * 18 * 1e6) / 1e6) / 10 : dh);
const degreeHoursLabel = (unit: TempUnit) => (unit === 'F' ? 'heat-index °F-hours' : 'heat-index degree-hours');
/** The NWS heat-index threshold the night's heat budget counts above (26.7 °C, 80 °F). */
const HEAT_BUDGET_FROM_C = 26.7;

/** "live data", or which groups are simulated (simulated data is never presented as real, plan §9.4). */
function dataText(o: DataOrigin): string {
  if (isFullyLive(o)) return 'live data';
  const simulated = DATA_GROUPS.filter((g) => o[g] === 'simulated').join(', ');
  return `simulated data (${simulated}${o.scenario === undefined ? '' : `, scenario ${o.scenario}`})`;
}

/** Each room's first setting in the plan, in time order. */
/** What the plan does in each room, by room label (CE-13): never an internal id. */
function roomSettings(p: Plan, names: Readonly<Record<string, string>> | undefined, unit: TempUnit): string {
  const first = new Map<string, Plan['steps'][number]>();
  for (const s of [...p.steps].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) if (!first.has(s.roomId)) first.set(s.roomId, s);
  if (first.size === 0) return 'no room is run';
  return [...first.values()]
    .map((s) => `${names?.[s.roomId] ?? 'a room'}: ${s.hvacMode === 'off' ? 'off' : `${s.hvacMode} at ${deg(s.setpointC, unit)}`}${s.fanOn ? ', fan on' : ''}`)
    .join('; ');
}

function rungText(r: LevelStep, names: Readonly<Record<string, string>> | undefined): string {
  const offset = `${r.setpointOffsetK >= 0 ? '+' : ''}${String(r.setpointOffsetK)} K`;
  const rooms = r.roomIds.length > 0 ? r.roomIds.map((id) => names?.[id] ?? 'a room').join(', ') : 'no rooms';
  return `${r.level}: setpoint ${offset}, ${r.preferredModes.join(' or ')}, fans ${r.fansOn ? 'on' : 'off'}, ${rooms}`;
}

/** One scenario of the counterfactual; without its night hours when the text already says one end time (#299). */
function lineText(l: CounterfactualLine, timeZone: string, nightHours: boolean, unit: TempUnit): string {
  const night = nightHours ? `, ${one(l.hoursAtOrBelowThreshold)} night hours at or below the threshold` : '';
  return `${deg(l.peakTempC, unit)} at ${localTimeText(localIso(Date.parse(l.peakAt), timeZone))} (${one(degreeHours(l.heatIndexDegreeHours, unit))} ${degreeHoursLabel(unit)}${night})`;
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
  /** The temperature unit the sandbox chose (#306); °C when unset. */
  readonly unit?: TempUnit;
}

const SURPLUS_REASON = { safe_room: 'safe room', occupied: 'occupied', occupied_tonight: 'slept in tonight' } as const;

/** Where the solar surplus went (#203), in order, by room name, with every number (F7): the scene reads alone. */
function surplusText(s: NonNullable<Plan['surplus']>, opts: PlanSummaryOptions): string {
  // Owner feedback: the room now against the comfort, then the setpoint ("cooled to 23 °C · 6.9 °C above target" was not understood).
  const unit = opts.unit ?? 'C';
  const rooms = s.rooms.map((r, i) => {
    const name = opts.roomNames?.[r.roomId] ?? 'a room';
    const side = r.aboveTargetK >= 0 ? 'above' : 'below';
    // With the comfort known, the gap comes from the rounded absolutes, so now − comfort adds up (#306); without it,
    // the gap alone (× 1.8 in °F).
    let versus: string;
    if (s.comfortC === undefined) {
      const gap = unit === 'F' ? Math.round(Math.abs(r.aboveTargetK) * 18) / 10 : Math.abs(r.aboveTargetK);
      versus = `${gap.toFixed(1)} °${unit} ${side} comfort`;
    } else {
      const g = tempGap(s.comfortC + r.aboveTargetK, s.comfortC, unit);
      versus = `now ${g.now.toFixed(1)} °${unit}, ${g.gap.toFixed(1)} °${unit} ${side} the ${g.ref.toFixed(1)} °${unit} comfort`;
    }
    return `${String(i + 1)}) ${name} (${SURPLUS_REASON[r.reason]}), ${versus}, cooling to ${deg(r.setpointC, unit)}`;
  });
  return (
    `Solar surplus from ${localTimeText(s.from)} to ${localTimeText(s.to)}: ${s.keptKWh.toFixed(1)} kWh kept at home instead of exported to the grid. ` +
    `Where it went, in order: ${rooms.join('; ')}.`
  );
}

const TIP_LOAD = { washing: 'run the washing machine', cooking: 'cook' } as const;
const TIP_CYCLE = { eco: 'an eco', normal: 'a normal', quick: 'a quick' } as const;

/**
 * The household tip from the surplus (#219): the load, its cycle and the window from the projection, never a brand.
 * Low forecast confidence: "probably", and no end time (owner decision of 4/10).
 */
function householdTipText(t: NonNullable<Plan['householdTip']>): string {
  const from = localTimeText(t.windowFrom);
  const advice = 'Advice only, nothing is switched on.';
  if (t.probable) {
    return `Probably a good time to ${TIP_LOAD[t.load]} from ${from}${t.cycle === undefined ? '' : `: ${TIP_CYCLE[t.cycle]} cycle should fit`}. ${advice}`;
  }
  const fits = t.cycle === undefined ? '' : `${TIP_CYCLE[t.cycle]} cycle fits; `;
  return `Good time to ${TIP_LOAD[t.load]} from ${from}: ${fits}the sun should cover it until about ${localTimeText(t.windowTo)}. ${advice}`;
}

/** The wall-clock hour of a time already in the home's zone (localIso), read from the text itself. */
function wallHour(iso: string): number {
  const m = /T(\d\d):(\d\d)/.exec(iso);
  return m === null ? Number.NaN : Number(m[1]) + Number(m[2]) / 60;
}

const inNight = (hour: number, o: PlanSummaryOptions) =>
  o.nightStartHour > o.nightEndHour ? hour >= o.nightStartHour || hour < o.nightEndHour : hour >= o.nightStartHour && hour < o.nightEndHour;

/** The window of a last resort (#160), every number of it, never a claim about the time before safeUntil. */
function windowText(lr: NonNullable<Plan['lastResort']>, opts: PlanSummaryOptions, horizonAt: string): string | undefined {
  // The battery runs out but the room stays inside its limit to the end of the plan: said, not left out (#272). Its
  // temperature limit: humidity may end a last resort, never this window.
  if (lr.limitedBy === 'battery' && lr.worstAt === undefined) {
    return `The safe room stays inside its temperature limit until ${localTimeText(horizonAt)}, the next recharge (the battery lasts until ${localTimeText(lr.safeUntil)}).`;
  }
  if (lr.comfortLimitC === undefined || lr.worstC === undefined || lr.worstAt === undefined) return undefined;
  // The room has gone past the limit (contract): below it is the heating season.
  const heating = lr.worstC < lr.comfortLimitC;
  const until = localTimeText(lr.safeUntil);
  const by = localTimeText(lr.worstAt);
  // The worst point is the end of the safe hours itself: "at" that time, never "up to … by" it.
  const atEnd = epochMs(lr.worstAt) === epochMs(lr.safeUntil);
  const unit = opts.unit ?? 'C';
  const temp = deg(lr.worstC, unit);
  // The limit came down at safeUntil with the room above it (decided by plan_comfort from the data, #166).
  if (lr.loweredLimitC !== undefined) {
    const head = `From ${until} the limit is ${deg(lr.loweredLimitC, unit)} and the safe room is above it`;
    return atEnd ? `${head}: at ${until} it is at ${temp}.` : `${head}, up to ${temp} by ${by}.`;
  }
  const limit = `${deg(lr.comfortLimitC, unit)}${!heating && inNight(wallHour(lr.worstAt), opts) ? ' night' : ''} limit`;
  // Both times in one sentence and no duration (#272): the battery runs out, the room holds the limit in force where
  // it crosses it (#272 review), then warms.
  if (lr.limitedBy === 'battery' && lr.limitCrossedAt !== undefined && !heating) {
    const crossedC = lr.limitCrossedC ?? lr.comfortLimitC;
    const crossedLimit = `${deg(crossedC, unit)}${inNight(wallHour(lr.limitCrossedAt), opts) ? ' night' : ''} limit`;
    // #364: the room's time leads, the battery's follows, as on the card and in the family alert.
    return `The safe room stays at or below its ${crossedLimit} until about ${localTimeText(lr.limitCrossedAt)} (the battery lasts until ${until}), then warms up to ${temp} by ${by}.`;
  }
  const then = atEnd
    ? `at ${until} the safe room is at ${temp}, past its ${limit}.`
    : `the safe room then goes ${heating ? 'down' : 'up'} to ${temp} by ${by}, past its ${limit}.`;
  return lr.limitedBy === 'battery' ? `The battery lasts until ${until}; ${then}` : `Safe until ${until}; ${then}`;
}

/**
 * #364: until when the room stays within its limits, the big time on the card: when the battery runs out first, the
 * crossing after it, or the next recharge when the room holds its limits that long; otherwise the end of the safe hours.
 */
function roomUntil(lr: NonNullable<Plan['lastResort']>, horizonAt: string): string {
  if (lr.limitedBy !== 'battery') return lr.safeUntil;
  // The crossing leads only when the room then gets warmer (#364 review): heating keeps the battery time.
  if (lr.limitCrossedAt !== undefined) return roomTimeLeads(lr) ? lr.limitCrossedAt : lr.safeUntil;
  return lr.worstAt === undefined ? horizonAt : lr.safeUntil;
}

/** The first words of a last resort (#364): the room's time first, then the battery's when it runs out earlier. */
function lastResortHead(lr: NonNullable<Plan['lastResort']>, horizonAt: string): string {
  const room = roomUntil(lr, horizonAt);
  if (lr.limitedBy !== 'battery') return `within its limits until ${localTimeText(lr.safeUntil)}`;
  if (room === lr.safeUntil) return `until the battery runs out at ${localTimeText(lr.safeUntil)}`;
  const about = lr.limitCrossedAt === undefined ? `${localTimeText(room)}, the next recharge` : `about ${localTimeText(room)}`;
  return `within its limits until ${about}, the battery until ${localTimeText(lr.safeUntil)}`;
}

/**
 * #376: what the card's last page says, so the voice can say it too: the zero-energy actions, the heat-stroke signs and
 * the number to call at the home's place (911 in Houston, 112 in Italy). General tips, never medical protection.
 */
function adviceText(lr: NonNullable<Plan['lastResort']>, unit: TempUnit): string | undefined {
  // The card's own words (the catalog), so voice and card say the same; a plan without its place names no number.
  if (lr.place === undefined) return undefined;
  const advice = lastResortAdvice('en-US', lr.actions ?? [], unit, lr.place);
  const todo = advice.actions.length === 0 ? '' : `${advice.title}: ${advice.actions.join(' ')} `;
  return `The card says: ${todo}${advice.signsTitle}: ${advice.signs.join('; ')}. ${advice.call} ${advice.notMedical}`;
}

export function planSummary(p: Plan, opts: PlanSummaryOptions): string {
  const level = p.steps[0]?.level ?? p.ladder[0]?.level ?? 'comfort';
  const commanded = p.advisoryOnly ? 'advice only, nothing is commanded' : 'nothing changes until apply_plan';
  const lr = p.lastResort;
  // A last resort opens with its honest window (CE-21): the model reads the first sentence first.
  const head =
    lr === undefined
      ? `Proposed plan: ${level} level until ${localTimeText(p.horizonAt)}`
      : `Proposed last-resort plan: the safe room alone, ${lastResortHead(lr, p.horizonAt)}`;
  // A refused proposal (#202): the first words say so and that this plan holds, so the model offers it at once.
  const refused =
    p.refusedProposal === undefined ? [] : [`The safety check refused the plan you proposed: ${p.refusedProposal.message} This plan holds instead and is ready to apply.`];
  const parts = [
    ...refused,
    `${head} (${commanded}), built on ${dataText(p.sourceOrigin)}.`,
    `What it does: ${roomSettings(p, opts.roomNames, opts.unit ?? 'C')}.`,
    ...(p.surplus === undefined ? [] : [surplusText(p.surplus, opts)]),
    ...(p.householdTip === undefined ? [] : [householdTipText(p.householdTip)]),
    `Confirming it also allows these steps down if the battery falls behind: ${p.ladder.map((r) => rungText(r, opts.roomNames)).join('; ')}.`,
    `Guarantees: ${p.guarantees.map((g) => `${g.id.replace(/_/g, ' ')} ${g.ok ? 'holds' : 'FAILS'}: ${g.reason}`).join(' ')}`,
    `Storm reserve ${one(p.reserveWh / 1000)} kWh${p.reserveFloorSocPct === undefined ? '' : `: the battery stays at or above ${one(p.reserveFloorSocPct)} % while the grid is up`}.`,
  ];
  // With a crossing time the window says the one end time; the night's hours (grace minutes counted) stay in
  // nightRecovery for the card, never a second duration in the text (#272 review).
  const n = p.nightRecovery;
  if (n !== undefined && lr?.limitCrossedAt === undefined) parts.push(nightText(n, opts));
  for (const w of p.warnings ?? []) parts.push(`Warning: ${w.message}`);
  const c = p.counterfactual;
  if (c !== undefined) {
    const { noPlan, naive, plan } = c.scenarios;
    // Next to a last resort's crossing time, no second duration for the room's threshold (#299): the night hours
    // (grace minutes counted) stay in the structured counterfactual for the card.
    const nightHours = lr?.limitCrossedAt === undefined;
    parts.push(
      `Without the plan the safe room${opts.roomNames?.[c.roomId] === undefined ? '' : `, ${opts.roomNames[c.roomId]},`} would peak at ${lineText(noPlan, opts.timeZone, nightHours, opts.unit ?? 'C')}; ` +
        `with the naive plan (air conditioning until the battery dies) at ${lineText(naive, opts.timeZone, nightHours, opts.unit ?? 'C')}; ` +
        `with this plan at ${lineText(plan, opts.timeZone, nightHours, opts.unit ?? 'C')}.`,
    );
  }
  const window = p.lastResort === undefined ? undefined : windowText(p.lastResort, opts, p.horizonAt);
  if (window !== undefined) parts.push(window);
  // #376: the card's page of what to do without power; the number to call is the home's, said only from here.
  const advice = p.lastResort === undefined ? undefined : adviceText(p.lastResort, opts.unit ?? 'C');
  if (advice !== undefined) parts.push(advice);
  // What the room does once the battery is empty, said not hidden (#160 acceptance test: up to ~100 % RH on a
  // humid night). The plan's own steps say the season: a heated room gets colder, never warmer.
  if (p.lastResort?.limitedBy === 'battery') {
    const heating = p.goal === 'heat' || p.steps.some((s) => s.hvacMode === 'heat');
    parts.push(`Once the battery runs out the split stops: the safe room gets ${heating ? 'colder' : 'warmer and more humid'}.`);
  }
  // A last resort is applied only with two explicit yeses (#168): the first apply_plan returns what the second needs.
  parts.push(
    p.lastResort === undefined
      ? // The pending plan, named, so a plain "yes" in the next turn applies it instead of planning again (#274).
        `Say it to the person and ask to confirm. Plan ${p.id} is waiting for the person's yes: when they say yes, call apply_plan with planId ${p.id}.`
      : `Last resort: the safest plan there is, but not every guarantee holds. It can be applied only with two explicit yeses: ` +
          `read the person the risk and until when the safe room stays within its limits (${localTimeText(roomUntil(p.lastResort, p.horizonAt))}), ask; ` +
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
  const unit = opts.unit ?? 'C';
  const heat =
    `the heat would reach ${String(heatAmount(n.heatIndexDegreeHoursAbove26_7, unit))} ${degreeHoursLabel(unit)} above ${deg(HEAT_BUDGET_FROM_C, unit)}, ` +
    `over the ${String(degreeHours(n.budgetDegreeHours, unit))} allowed`;
  const overBudget = n.heatIndexDegreeHoursAbove26_7 > n.budgetDegreeHours;
  // With no hour required, only the heat budget can fail: say that, not "0.5 of 0 hours".
  if (n.requiredHours === 0 && n.status !== 'met') return `${head} ${n.status}: ${heat}.`;
  const best = n.bestAchievableHours === undefined ? '' : `, best achievable ${String(n.bestAchievableHours)} hours`;
  const hours = `${String(n.achievedHours)} of ${String(n.requiredHours)} hours at or below ${deg(n.thresholdC, unit)}${best}`;
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
  const applied = o.alreadyApplied ? `The plan was already applied.` : `The plan was applied${o.advisoryOnly ? ' as advice' : ''}.`;
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
  // The grid in words, and an empty battery said as such (#273): the model only reads this text.
  const grid = o.gridAvailable ? 'The grid is on.' : 'The grid is down.';
  const asOf = `As of ${localTimeText(o.ts)} (${dataText(o.origin)}).`;
  if (o.hoursAtCurrentLevel === 0 && o.hoursAtEssential === 0 && o.reserveHoursAtEssential === 0) {
    return `The battery is empty: 0 hours on the battery, at any level, and none left in the storm reserve. ${grid} ${asOf}`;
  }
  // On grid the spendable hours are only what comfort may use above the storm reserve (#21): said so, or "0 hours"
  // next to "the reserve gives 1 hour" reads as a contradiction (#287 review). Off grid it is the whole battery.
  const spendable = o.gridAvailable ? 'For comfort, above the storm reserve' : 'On the battery alone';
  return (
    `${spendable}: about ${one(o.hoursAtCurrentLevel)} hours at ${o.level} level, or ${one(o.hoursAtEssential)} hours at essential with the same energy; ` +
    `the storm reserve alone gives ${one(o.reserveHoursAtEssential)} hours at essential. ${grid} ${asOf}`
  );
}
