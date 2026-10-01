import { DATA_GROUPS, isFullyLive, type ApplyPlanOutput, type CounterfactualLine, type DataOrigin, type LevelStep, type Plan, type ReserveOutlook } from '@cold-reserve/contracts';

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
function roomSettings(p: Plan): string {
  const first = new Map<string, Plan['steps'][number]>();
  for (const s of [...p.steps].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) if (!first.has(s.roomId)) first.set(s.roomId, s);
  if (first.size === 0) return 'no room is run';
  return [...first.values()]
    .map((s) => `${s.roomId}: ${s.hvacMode === 'off' ? 'off' : `${s.hvacMode} at ${String(s.setpointC)} °C`}${s.fanOn ? ', fan on' : ''}`)
    .join('; ');
}

function rungText(r: LevelStep): string {
  const offset = `${r.setpointOffsetK >= 0 ? '+' : ''}${String(r.setpointOffsetK)} K`;
  const rooms = r.roomIds.length > 0 ? r.roomIds.join(', ') : 'no rooms';
  return `${r.level}: setpoint ${offset}, ${r.preferredModes.join(' or ')}, fans ${r.fansOn ? 'on' : 'off'}, ${rooms}`;
}

function lineText(l: CounterfactualLine): string {
  return `${String(l.peakTempC)} °C at ${l.peakAt} (${one(l.heatIndexDegreeHours)} heat-index degree-hours, ${one(l.hoursAtOrBelowThreshold)} night hours at or below the threshold)`;
}

/** What the plan text needs besides the plan: the length of the night window (guard config). */
export interface PlanSummaryOptions {
  readonly nightWindowHours: number;
}

export function planSummary(p: Plan, opts: PlanSummaryOptions): string {
  const level = p.steps[0]?.level ?? p.ladder[0]?.level ?? 'comfort';
  const parts = [
    `Proposed plan ${p.id}: ${level} level until ${p.horizonAt} (${p.advisoryOnly ? 'advice only, nothing is commanded' : 'nothing changes until apply_plan'}), built on ${dataText(p.sourceOrigin)}.`,
    `What it does: ${roomSettings(p)}.`,
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
      `Without the plan the safe room (${c.roomId}) would peak at ${lineText(noPlan)}; ` +
        `with the naive plan (air conditioning until the battery dies) at ${lineText(naive)}; ` +
        `with this plan at ${lineText(plan)}.`,
    );
  }
  parts.push(`Say it to the person and ask to confirm; then call apply_plan with planId ${p.id}.`);
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
  const head = o.alreadyApplied ? `Plan ${o.plan.id} was already applied.` : `Plan ${o.plan.id} applied${o.advisoryOnly ? ' as advice' : ''}.`;
  if (!o.advisoryOnly) return head;
  const steps = o.manualInstructions.map((m) => m.text).join('; ');
  return `${head} Nothing is commanded on this home: set it by hand. ${steps}.`;
}

export function outlookSummary(o: ReserveOutlook): string {
  return (
    `On the battery alone: about ${one(o.hoursAtCurrentLevel)} hours at ${o.level} level, or ${one(o.hoursAtEssential)} hours at essential with the same energy; ` +
    `the storm reserve alone gives ${one(o.reserveHoursAtEssential)} hours at essential. As of ${o.ts} (${dataText(o.origin)}).`
  );
}
