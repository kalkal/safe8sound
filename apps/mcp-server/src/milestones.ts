import { MAX_MILESTONES, epochMs, type Milestone, type MilestoneKind, type Plan } from '@cold-reserve/contracts';
import { localIso } from '@cold-reserve/core';
import type { Scenario } from '@cold-reserve/source-simulator';

// The next interesting moments of a sandbox's day (#311), for the judges' clock: read from the scenario's grid
// outages and from the plan's own fields, never recomputed apart, so the clock and the plan always agree.

const LABEL: Readonly<Record<MilestoneKind, string>> = {
  pre_cooling_start: 'Pre-cooling starts',
  surplus_start: 'The solar surplus starts',
  surplus_end: 'The solar surplus ends',
  storm_start: 'The storm starts: the grid goes down',
  power_back: 'Power is back (stable)',
  essential_level: 'The battery reaches the essential level',
  limit_crossed: 'The safe room passes its limit',
  last_resort_end: "The last resort's safe hours end",
  next_recharge: 'Next recharge',
};

/** The first step that lowers a room's setpoint below its previous one: the plan starts cooling ahead of a limit. */
function preCoolingStart(steps: Plan['steps']): string | undefined {
  const last = new Map<string, number>();
  for (const s of [...steps].sort((a, b) => epochMs(a.ts) - epochMs(b.ts))) {
    const before = last.get(s.roomId);
    if (s.hvacMode !== 'off') last.set(s.roomId, s.setpointC);
    if (before !== undefined && s.hvacMode === 'cool' && s.setpointC < before) return s.ts;
  }
  return undefined;
}

/** The first plan step at the essential level: where the battery reaches it, for the list and for the jump alike. */
export function firstEssentialMs(plan: Plan): number | undefined {
  const times = plan.steps.filter((s) => s.level === 'essential').map((s) => epochMs(s.ts));
  return times.length === 0 ? undefined : Math.min(...times);
}

/** The earlier of two moments, either of which may be unknown. */
export const earliest = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

export function milestonesOf(o: {
  readonly nowMs: number;
  /** Only moments before this instant are listed (the clock looks a day ahead). */
  readonly horizonMs: number;
  readonly timeZone: string;
  /** The scenario's grid outages, epoch ms. */
  readonly outages?: readonly { readonly fromMs: number; readonly toMs: number }[];
  /**
   * How long the grid must stay back before the storm ends (storm-mode `stableGridMinutes`): power back is listed then,
   * when the family's message is sent, so a jump to it shows the message at once.
   */
  readonly stableGridMs?: number;
  readonly plan?: Plan;
  /** #390: when the scripted home steps down to its essential settings (the scenario's own essential level), when it does. */
  readonly essentialAtMs?: number;
  /** When the battery recharges next (the guard's dark window end), when known. */
  readonly rechargeAtMs?: number;
}): Milestone[] {
  const found: { kind: MilestoneKind; ms: number }[] = [];
  const add = (kind: MilestoneKind, ms: number | undefined) => {
    if (ms !== undefined) found.push({ kind, ms });
  };
  for (const outage of o.outages ?? []) {
    add('storm_start', outage.fromMs);
    add('power_back', outage.toMs + (o.stableGridMs ?? 0));
  }
  const p = o.plan;
  // The plan's first essential step or the scripted home's (#390), whichever comes first ahead: a plan made in the storm
  // is essential from its first step, now, and the night's step down is still a moment to stop at.
  const ahead = (ms: number | undefined) => (ms !== undefined && ms > o.nowMs ? ms : undefined);
  const essentialAhead = earliest(ahead(p === undefined ? undefined : firstEssentialMs(p)), ahead(o.essentialAtMs));
  if (p === undefined) add('essential_level', essentialAhead);
  if (p !== undefined) {
    const pre = preCoolingStart(p.steps);
    add('pre_cooling_start', pre === undefined ? undefined : epochMs(pre));
    add('essential_level', essentialAhead);
    if (p.surplus !== undefined) {
      add('surplus_start', epochMs(p.surplus.from));
      add('surplus_end', epochMs(p.surplus.to));
    }
    const lr = p.lastResort;
    if (lr !== undefined) {
      add('last_resort_end', epochMs(lr.safeUntil));
      add('limit_crossed', lr.limitCrossedAt === undefined ? undefined : epochMs(lr.limitCrossedAt));
    }
  }
  add('next_recharge', o.rechargeAtMs);
  // A stable order on a tie: the order the kinds were found in.
  return found
    .map((m, i) => ({ ...m, i }))
    .filter((m) => m.ms > o.nowMs && m.ms <= o.horizonMs)
    .sort((a, b) => a.ms - b.ms || a.i - b.i)
    .slice(0, MAX_MILESTONES)
    .map((m) => ({ kind: m.kind, at: localIso(m.ms, o.timeZone), label: LABEL[m.kind] }));
}

/** #390: when the scripted home steps down to its essential settings, as an instant (undefined: it never does). */
export function essentialAtOf(scenario: Scenario): number | undefined {
  return scenario.essentialAtH === undefined ? undefined : Date.parse(scenario.startAt) + scenario.essentialAtH * 3_600_000;
}

/**
 * The grid outages a scenario plays (its own and its place's, merged by the simulator), as instants: the same
 * hours from its start that the simulator reads (inputsAt), so the clock and the home agree on the storm.
 */
export function outagesOf(scenario: Scenario): { fromMs: number; toMs: number }[] {
  const start = Date.parse(scenario.startAt);
  return scenario.gridOutages.map((o) => ({ fromMs: start + o.fromH * 3_600_000, toMs: start + o.toH * 3_600_000 }));
}
