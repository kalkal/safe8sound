import {
  AdvanceClockInputSchema,
  AdvanceClockOutputSchema,
  GetMilestonesInputSchema,
  GetMilestonesOutputSchema,
  categoryOf,
  err,
  ok,
  toolError,
  type AdvanceClockInput,
  type ErrorEnvelope,
  type GetMilestonesInput,
  type HomeId,
  type Plan,
  type PlanId,
  type Result,
  type SandboxSettings,
} from '@cold-reserve/contracts';
import { localIso, utcDayStart, type Clock, type Logger } from '@cold-reserve/core';
import { earliest, firstEssentialMs, milestonesOf } from '../milestones.js';
import { homeDetail, isSandbox } from '../sandbox-log.js';
import { defineTool, type ToolContext, type ToolDefinition } from '../tool.js';

// The judges' clock (#311, approved in #311): a visitor lists the next moments of their own sandbox's day and jumps to
// one, or some hours ahead. The jump is scenario time added to the start (`advancedMs`): the playthrough stays, so the
// storm sessions and the inbox stay. Never backwards (a restart is the only way back), never past the scenario's end.
// The storm detector runs at every storm start and power back on the way, and at the target, so the family gets each
// message exactly once, as in real time. Plan expiry runs on domain time: a jump can expire a proposed plan.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A sandbox's day as this container plays it. */
export interface SandboxDay {
  /** Scenario time now. */
  readonly nowMs: number;
  /** The settings version played here (undefined: the defaults, nothing saved): a jump is planned on it. */
  readonly version: number | undefined;
  /** The wall instant the current playthrough began: a first jump pins it, so the day never rolls over under it. */
  readonly anchorMs: number;
  /** The scenario's start (its start hour included) and its end. */
  readonly startMs: number;
  readonly endMs: number;
  readonly timeZone: string;
  /** The grid outages the scenario plays. */
  readonly outages: readonly { readonly fromMs: number; readonly toMs: number }[];
  /** When the battery recharges next (the dark window's end), when the forecast shows it. */
  readonly rechargeAtMs?: number;
  /** #390: when the scripted home steps down to its essential settings (the scenario's own essential level), when it does. */
  readonly essentialAtMs?: number;
}

export interface DemoClockDeps {
  readonly day: (homeId: HomeId) => SandboxDay | undefined;
  readonly getPlan: (homeId: HomeId, planId: PlanId, correlationId: string) => Promise<Result<Plan, ErrorEnvelope>>;
  /** One storm detector pass at the sandbox's time now: a reading, or the reading that reaches the essential level. */
  readonly detect: (ctx: ToolContext, kind: 'reading' | 'essential') => Promise<Result<void, ErrorEnvelope>>;
  /** How long the grid must stay back before the storm ends (storm-mode `stableGridMinutes`). */
  readonly stableGridMs: number;
  /** Jumps per sandbox per UTC day, on top of the sim-api tool quota per code. */
  readonly maxAdvancesPerDay: number;
}

/** What the clock needs of the settings module: read and save the sandbox's settings, played here at once. */
export interface SettingsAccess {
  readonly read: (homeId: HomeId, correlationId: string) => Promise<Result<{ settings: SandboxSettings; version: number | undefined }, ErrorEnvelope>>;
  readonly save: (homeId: HomeId, next: SandboxSettings, expected: number | undefined, correlationId: string) => Promise<Result<void, ErrorEnvelope>>;
}

/** The settings a jump builds on, and the version they were stored with (undefined: the defaults, nothing saved). */
type StoredSettings = { readonly settings: SandboxSettings; readonly version: number | undefined };

const notHere = (): ErrorEnvelope => toolError('home_not_allowed', 'Only a visitor sandbox has a demo clock.');
const movedOn = (): ErrorEnvelope => toolError('settings_version_conflict', 'The day moved on meanwhile: ask get_milestones again.');

/** The sandbox's own plan, or plan_not_found: another home's plan is never told apart from a missing one. */
async function ownPlan(deps: DemoClockDeps, homeId: HomeId, planId: PlanId | undefined, correlationId: string): Promise<Result<Plan | undefined, ErrorEnvelope>> {
  if (planId === undefined) return ok(undefined);
  const plan = await deps.getPlan(homeId, planId, correlationId);
  if (!plan.ok) return plan;
  return plan.value.homeId === homeId ? ok(plan.value) : err(toolError('plan_not_found', 'No such plan in this sandbox.'));
}

const listOf = (day: SandboxDay, plan: Plan | undefined, stableGridMs: number) =>
  milestonesOf({
    nowMs: day.nowMs,
    // The next 24 hours, never past the scenario's end: a listed moment can always be jumped to.
    horizonMs: Math.min(day.nowMs + DAY_MS, day.endMs),
    timeZone: day.timeZone,
    outages: day.outages,
    stableGridMs,
    ...(plan === undefined ? {} : { plan }),
    ...(day.rechargeAtMs === undefined ? {} : { rechargeAtMs: day.rechargeAtMs }),
    ...(day.essentialAtMs === undefined ? {} : { essentialAtMs: day.essentialAtMs }),
  });

/**
 * Where the detector runs on the way to `toMs` (after now, up to it): each storm start, power back and stable grid,
 * the first essential step (the plan's or the scripted home's, #390), the target. From that step on every stop is an essential reading: the planner keeps
 * one level for a whole plan, so a plan made in the storm is essential from its first step (often now), and the family
 * hears it at the first stop of the storm. The detector tells it once, during an active storm only.
 */
function stopsOf(day: SandboxDay, plan: Plan | undefined, toMs: number, stableGridMs: number): { atMs: number; kind: 'reading' | 'essential' }[] {
  const times: number[] = [];
  for (const o of day.outages) times.push(o.fromMs, o.toMs, o.toMs + stableGridMs);
  const essential = earliest(plan === undefined ? undefined : firstEssentialMs(plan), day.essentialAtMs);
  if (essential !== undefined) times.push(essential);
  const ahead = [...new Set(times.filter((t) => t > day.nowMs && t < toMs))].sort((a, b) => a - b);
  return [...ahead, toMs].map((atMs) => ({ atMs, kind: essential !== undefined && atMs >= essential ? 'essential' : 'reading' }));
}

export function demoClockTools(deps: DemoClockDeps, settings: SettingsAccess, o: { readonly wallClock: Clock; readonly logger: Logger }): ToolDefinition[] {
  /** Jumps per sandbox in the current UTC day (wall time), in this container. */
  const used = new Map<HomeId, { dayMs: number; count: number }>();

  const getMilestones = defineTool({
    name: 'get_milestones',
    title: 'Next moments of the day',
    description:
      "The next interesting moments of this demo sandbox's day (the storm, power back, the next recharge and, with a plan id, the plan's own moments), with the time now and the day's span. Only the visitor's own sandbox.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    input: GetMilestonesInputSchema,
    output: GetMilestonesOutputSchema,
    summarize: (out) =>
      `Now ${out.now}; the day runs from ${out.day.from} to ${out.day.to}. ` +
      (out.milestones.length === 0 ? 'No moment ahead in the next 24 hours.' : `Next: ${out.milestones.map((m) => `${m.label} at ${m.at}`).join('; ')}.`),
    handler: async (args: GetMilestonesInput, ctx) => {
      if (!isSandbox(ctx.homeId)) return err(notHere());
      const day = deps.day(ctx.homeId);
      if (day === undefined) return err(toolError('home_not_found', 'This sandbox is not playing.'));
      const plan = await ownPlan(deps, ctx.homeId, args.planId, ctx.correlationId);
      if (!plan.ok) return plan;
      return ok({
        now: localIso(day.nowMs, day.timeZone),
        // A day of 24 hours, never past the scenario's end: the clear day played from 12:00 ends at midnight (#449).
        day: { from: localIso(day.startMs, day.timeZone), to: localIso(Math.min(day.startMs + DAY_MS, day.endMs), day.timeZone) },
        milestones: listOf(day, plan.value, deps.stableGridMs),
      });
    },
  });

  const advanceClock = defineTool({
    name: 'advance_clock',
    title: 'Jump ahead in the day',
    description:
      'Moves this demo sandbox ahead to a moment listed by get_milestones (its kind and at), or some hours ahead (1 to 24). Never backwards: set_scenario with restart: true plays the day again. The family phone gets the storm messages on the way. Only the visitor\'s own sandbox.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    input: AdvanceClockInputSchema,
    output: AdvanceClockOutputSchema,
    summarize: (out) => `The sandbox's time is now ${out.now} (settings version ${String(out.settingsVersion)}).`,
    handler: async (args: AdvanceClockInput, ctx) => {
      if (!isSandbox(ctx.homeId)) return err(notHere());
      const wallMs = o.wallClock.now();
      const today = utcDayStart(wallMs);
      const quota = used.get(ctx.homeId);
      const count = quota?.dayMs === today ? quota.count : 0;
      if (count >= deps.maxAdvancesPerDay) {
        return err(toolError('demo_quota_exceeded', 'This sandbox has jumped ahead enough for today.', { retryAfterMs: today + DAY_MS - wallMs }));
      }
      const day = deps.day(ctx.homeId);
      if (day === undefined) return err(toolError('home_not_found', 'This sandbox is not playing.'));
      const plan = await ownPlan(deps, ctx.homeId, args.planId, ctx.correlationId);
      if (!plan.ok) return plan;

      let toMs: number;
      if (args.hours !== undefined) {
        toMs = day.nowMs + args.hours * HOUR_MS;
      } else {
        const wanted = Date.parse(args.at ?? '');
        const listed = listOf(day, plan.value, deps.stableGridMs).find((m) => m.kind === args.kind && Date.parse(m.at) === wanted);
        if (listed === undefined) return err(toolError('invalid_input', 'Not a moment ahead in this day: ask get_milestones again.', { details: { field: 'at' } }));
        toMs = wanted;
      }
      if (toMs > day.endMs) return err(toolError('invalid_input', "That is past the end of the scenario's day: restart it to play it again.", { details: { field: args.hours === undefined ? 'at' : 'hours' } }));

      used.set(ctx.homeId, { dayMs: today, count: count + 1 });
      const fromMs = day.nowMs;
      // #406: the settings are read once, before the first stop; each stop then builds on the settings the previous one
      // saved. Each stop is saved on the version the jump was planned on, then on its own: a concurrent jump (a double
      // tap, another container) makes one of them a conflict, never a clock moved twice or backwards.
      const stored = await settings.read(ctx.homeId, ctx.correlationId);
      if (!stored.ok) {
        logFailure(ctx, stored.error);
        return stored;
      }
      if (stored.value.version !== day.version) {
        const conflict = movedOn();
        logFailure(ctx, conflict);
        return err(conflict);
      }
      let saved = stored.value;
      for (const stop of stopsOf(day, plan.value, toMs, deps.stableGridMs)) {
        const moved = await moveTo(ctx, stop.atMs, saved);
        const detected = moved.ok ? await deps.detect(ctx, stop.kind) : moved;
        if (!detected.ok) {
          logFailure(ctx, detected.error);
          return detected;
        }
        if (moved.ok) saved = { settings: moved.value, version: moved.value.version };
      }
      const version = saved.version;
      o.logger.log({
        ts: new Date(wallMs).toISOString(),
        level: 'info',
        component: 'mcp-server',
        message: 'The sandbox jumped ahead in its day.',
        correlationId: ctx.correlationId,
        details: { event: 'clock_advanced', from: localIso(fromMs, day.timeZone), to: localIso(toMs, day.timeZone), kind: args.kind ?? 'hours', ...homeDetail(ctx.homeId) },
      });
      return ok({ now: localIso(toMs, day.timeZone), settingsVersion: version ?? 0 });
    },
  });

  /**
   * Saves the jump that puts the sandbox's now at `atMs` (a new settings version) and plays it here, only on the
   * settings `current` (read before the first stop, or saved by the previous one): settings moved since, here or in
   * another container (the conditional save), or a now already past `atMs`, are a conflict, never a clock moved back.
   */
  async function moveTo(ctx: ToolContext, atMs: number, current: StoredSettings): Promise<Result<SandboxSettings, ErrorEnvelope>> {
    const day = deps.day(ctx.homeId);
    if (day === undefined) return err(toolError('home_not_found', 'This sandbox is not playing.'));
    if (day.version !== current.version || atMs < day.nowMs) return err(movedOn());
    const before = current.settings;
    const next: SandboxSettings = {
      ...before,
      version: (current.version ?? 0) + 1,
      updatedAt: new Date(o.wallClock.now()).toISOString(),
      // The playthrough is pinned: the same anchor, so a daily anchor never rolls the day over under a jump.
      scenarioStartedAt: before.scenarioStartedAt ?? new Date(day.anchorMs).toISOString(),
      advancedMs: Math.round((before.advancedMs ?? 0) + atMs - day.nowMs),
    };
    const saved = await settings.save(ctx.homeId, next, current.version, ctx.correlationId);
    if (saved.ok) return ok(next);
    // The store says the same conflict in its own words: the visitor hears the clock's.
    return saved.error.code === 'settings_version_conflict' ? err(movedOn()) : saved;
  }

  function logFailure(ctx: ToolContext, error: ErrorEnvelope): void {
    const category = categoryOf(error.code);
    o.logger.log({
      ts: new Date(o.wallClock.now()).toISOString(),
      // A concurrent jump is expected (a double tap): a warning; anything else is an error.
      level: category === 'conflict' ? 'warn' : 'error',
      component: 'mcp-server',
      message: 'The sandbox jump stopped on the way: it stays where it stopped.',
      correlationId: ctx.correlationId,
      code: error.code,
      category,
      details: { event: 'clock_advance_failed', ...homeDetail(ctx.homeId) },
    });
  }

  return [getMilestones, advanceClock];
}
