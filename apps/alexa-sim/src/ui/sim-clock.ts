import {
  AdvanceClockOutputSchema,
  GetMilestonesOutputSchema,
  err,
  ok,
  toolError,
  type ErrorEnvelope,
  type GetMilestonesOutput,
  type Milestone,
  type Result,
} from '@cold-reserve/contracts';
import type { Agent, AskContext } from '../agent/agent.js';
import type { CardSlot } from '../agent/wire.js';
import { log as defaultLog, type Log } from '../log.js';

// The simulated clock (owner decision, 10 Oct; backend #317): any visitor moves the simulated home to its next
// interesting moment (the storm, the essential level, the plan's moments, power back) and sees what the app does
// and what Ana's phone receives. "Power cut" (asked, typed, said or tapped) first makes the simulated grid go down,
// so the assistant answers a real outage and storm mode really starts (time pack, 12 Oct).
// Everything goes through the sandbox's own tools (get_milestones, advance_clock, set_scenario): never the real home.

/** The simulated time and the next moment the clock can skip to. */
export interface ClockState {
  /** Local ISO time in the home's zone, with its offset. */
  readonly now: string;
  readonly next?: Milestone;
}

/** "HH:MM" of a local ISO time: the home's own wall time, whatever the viewer's zone. */
export function clockTime(iso: string): string {
  const match = /T(\d{2}):(\d{2})/.exec(iso);
  return match === null ? '' : `${match[1] ?? ''}:${match[2] ?? ''}`;
}

/**
 * A statement that the power is out now (English and Italian, as typed or recognised): "Power cut" as the example says
 * it, "The power's out", "È saltata la corrente". Never a question ("Is the power out?", "C'è un blackout?"), a
 * hypothetical or a plan for later ("How long can we last in a power cut?", "Se manca la corrente cosa faccio?"), nor
 * the power coming back: those are asked as they are, the simulated home unchanged (review of #378). Word edges are
 * letters in any script (`\p{L}`): JavaScript's `\b` stops at accented letters.
 */
const EDGE_BEFORE = String.raw`(?<!\p{L})`;
const EDGE_AFTER = String.raw`(?!\p{L})`;
const words = (alternatives: readonly string[]) => new RegExp(`${EDGE_BEFORE}(?:${alternatives.join('|')})${EDGE_AFTER}`, 'u');
const NOT_NOW = words([
  'if', 'what if', 'will', "won't", 'would', 'could', 'might', 'should', 'tomorrow', 'tonight', 'later', 'prepare', 'ready',
  'how long', 'how', 'when', 'in case', 'before', 'back', 'again', 'turn', 'switch',
  'se', 'domani', 'stasera', 'stanotte', 'dopo', 'cosa faccio', 'quando', 'prepara', 'preparare', 'pronta', 'pronto',
  'nel caso', 'in caso', 'prima', 'quanto', 'come', 'tornata', 'tornato', 'torna',
]);
const POWER_CUT = [
  words([String.raw`power(?:'s| is| has)?(?: just| gone)?(?: went| gone)? (?:out|off|down)`]),
  // The outage named alone, or that there is one: "Power cut", "We have a blackout", "There's a power outage at home".
  new RegExp(String.raw`^(?:(?:we have|we've got|we've had|there's|there is) )?(?:a )?(?:power cut|power outage|power failure|black ?out)(?: at home| now| here)?[.!]*$`, 'u'),
  words(['lost power', 'lost the power', 'no power', String.raw`grid(?:'s| is)?(?: gone)? down`]),
  words([
    String.raw`(?:è |e )?(?:saltata|andata via|mancata) la (?:corrente|luce)`,
    String.raw`(?:la )?(?:corrente|luce) (?:è|e) (?:saltata|andata via|mancata)`,
    'manca la (?:corrente|luce)',
    'siamo senza (?:corrente|luce)',
  ]),
  new RegExp(String.raw`^(?:c'è |abbiamo )?(?:un )?black ?out(?: a casa| adesso| ora)?[.!]*$`, 'u'),
];

export function isPowerCut(text: string): boolean {
  const said = text.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
  if (said.includes('?') || NOT_NOW.test(said)) return false;
  return POWER_CUT.some((pattern) => pattern.test(said));
}

/** The plan on screen, whose own moments (the essential level, the emergency plan's end) the clock lists too. */
export function planIdOf(cards: readonly CardSlot[] | undefined): string | undefined {
  for (const card of [...(cards ?? [])].reverse()) {
    if (card.tool === 'plan_comfort' && 'id' in card.result && typeof card.result.id === 'string') return card.result.id;
  }
  return undefined;
}

async function call<T>(
  agent: Agent,
  name: 'get_milestones' | 'advance_clock' | 'set_scenario',
  args: Record<string, unknown>,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
  context: AskContext,
  logEvent: Log,
): Promise<Result<T, ErrorEnvelope>> {
  let failure: ErrorEnvelope;
  try {
    const reply = await agent.callTool(name, args, context);
    if (reply.isError !== true) {
      const parsed = parse(reply.structuredContent);
      if (parsed.success) return ok(parsed.data);
      failure = toolError('output_schema_violation', 'The simulated clock came back in an unexpected format.');
    } else {
      // The refusal's own code, and when a daily limit lifts (review of #378): "Try again" is never said when it cannot work.
      const refusal = reply.structuredContent as { code?: unknown; retryAfterMs?: unknown } | undefined;
      const code = refusal?.code;
      const retryAfterMs = refusal?.retryAfterMs;
      failure = toolError(
        code === 'plan_not_found' || code === 'settings_version_conflict' || code === 'demo_quota_exceeded' || code === 'agent_unavailable' || code === 'agent_timeout' ? code : 'invalid_input',
        'The simulated clock refused that step.',
        typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? { retryAfterMs } : {},
      );
    }
  } catch (error) {
    failure = toolError('agent_unavailable', 'The simulated clock could not be reached.');
    logEvent({ level: 'warn', code: failure.code, correlationId: context.correlationId, error, details: { step: name } });
    return err(failure);
  }
  logEvent({ level: 'warn', code: failure.code, correlationId: context.correlationId, details: { step: name } });
  return err(failure);
}

/** The moments ahead, with the plan's own when there is one; a plan the sandbox no longer knows is left out. */
async function milestones(agent: Agent, planId: string | undefined, context: AskContext, logEvent: Log): Promise<Result<GetMilestonesOutput & { planId?: string }, ErrorEnvelope>> {
  const parse = (v: unknown) => GetMilestonesOutputSchema.safeParse(v);
  if (planId !== undefined) {
    const withPlan = await call(agent, 'get_milestones', { planId }, parse, context, logEvent);
    if (withPlan.ok) return ok({ ...withPlan.value, planId });
    if (withPlan.error.code !== 'plan_not_found') return withPlan;
  }
  return call(agent, 'get_milestones', {}, parse, context, logEvent);
}

const stateOf = (list: GetMilestonesOutput): ClockState => {
  const [next] = list.milestones;
  return next === undefined ? { now: list.now } : { now: list.now, next };
};

/** The simulated time now and the next moment. */
export async function readClock(agent: Agent, planId: string | undefined, context: AskContext, logEvent: Log = defaultLog): Promise<Result<ClockState, ErrorEnvelope>> {
  const list = await milestones(agent, planId, context, logEvent);
  return list.ok ? ok(stateOf(list.value)) : list;
}

/** Skips to the next moment: the family phone gets what the home sends on the way. */
export async function skipAhead(
  agent: Agent,
  planId: string | undefined,
  context: AskContext,
  logEvent: Log = defaultLog,
): Promise<Result<{ state: ClockState; reached: Milestone }, ErrorEnvelope>> {
  const list = await milestones(agent, planId, context, logEvent);
  if (!list.ok) return list;
  const [target] = list.value.milestones;
  if (target === undefined) return err(toolError('invalid_input', 'Nothing more to skip to today.'));
  const moved = await call(
    agent,
    'advance_clock',
    { kind: target.kind, at: target.at, ...(list.value.planId === undefined ? {} : { planId: list.value.planId }) },
    (v) => AdvanceClockOutputSchema.safeParse(v),
    context,
    logEvent,
  );
  if (!moved.ok) {
    // The page may give up before the home answers (cold start, slow link) though the move went through: read the clock
    // again, and show the real state instead of nothing (15 Oct, found on a phone).
    // If the read comes before the home has finished, the time is unchanged and the failure stays: the next tap reads the real state.
    if (moved.error.code !== 'agent_timeout' && moved.error.code !== 'agent_unavailable') return moved;
    const real = await readClock(agent, list.value.planId, context, logEvent);
    if (!real.ok || real.value.now === list.value.now) return moved;
    logEvent({ level: 'info', code: 'clock_skipped', correlationId: context.correlationId, details: { kind: target.kind, recovered: true } });
    return ok({ state: real.value, reached: target });
  }
  logEvent({ level: 'info', code: 'clock_skipped', correlationId: context.correlationId, details: { kind: target.kind } });
  const after = await readClock(agent, list.value.planId, context, logEvent);
  return ok({ state: after.ok ? after.value : { now: moved.value.now }, reached: target });
}

/**
 * The grid goes down in the simulated home (the storm scenario, at its storm start). `stormScenario`: the sandbox
 * already plays the storm. The day starts again when its storm is over, so a power cut can always be shown.
 * Resolves to the clock after the cut; `changed` is false when the grid was already down.
 */
export async function cutThePower(
  agent: Agent,
  o: {
    readonly stormScenario: boolean;
    /** Whether the family already heard of this storm (Ana's phone shows storm_started). */
    readonly familyTold: boolean;
    readonly saveStorm: (change: { scenarioId: 'storm-blackout' } | { restart: true }) => Promise<boolean>;
  },
  context: AskContext,
  logEvent: Log = defaultLog,
): Promise<Result<{ state: ClockState; changed: boolean }, ErrorEnvelope>> {
  const fail = (code: 'invalid_input' | 'agent_unavailable', step: string): Result<never, ErrorEnvelope> => {
    logEvent({ level: 'warn', code, correlationId: context.correlationId, details: { step } });
    return err(toolError(code, 'The simulated power cut could not start.'));
  };
  if (!o.stormScenario && !(await o.saveStorm({ scenarioId: 'storm-blackout' }))) return fail('agent_unavailable', 'power_cut_scenario');
  let list = await milestones(agent, undefined, context, logEvent);
  if (!list.ok) return list;
  const kinds = list.value.milestones.map((m) => m.kind);
  const stormOver = !kinds.includes('storm_start') && !kinds.includes('power_back');
  // The grid went down on its own clock (a sandbox's day runs in real time) and nothing told the family: the storm check
  // runs on a jump or a storm-mode call only, so it would never be told. Play the day again up to its storm (#378 review).
  const downUntold = !kinds.includes('storm_start') && kinds.includes('power_back') && !o.familyTold;
  // The storm is over (power back is behind): the day plays again, up to its storm.
  if (stormOver || downUntold) {
    if (!(await o.saveStorm({ restart: true }))) return fail('agent_unavailable', 'power_cut_restart');
    list = await milestones(agent, undefined, context, logEvent);
    if (!list.ok) return list;
  }
  const storm = list.value.milestones.find((m) => m.kind === 'storm_start');
  // No storm ahead but power back is: the grid is already down.
  if (storm === undefined) {
    return list.value.milestones.some((m) => m.kind === 'power_back') ? ok({ state: stateOf(list.value), changed: false }) : fail('invalid_input', 'power_cut_no_storm');
  }
  const moved = await call(agent, 'advance_clock', { kind: storm.kind, at: storm.at }, (v) => AdvanceClockOutputSchema.safeParse(v), context, logEvent);
  if (!moved.ok) return moved;
  logEvent({ level: 'info', code: 'power_cut_simulated', correlationId: context.correlationId, details: { kind: storm.kind } });
  const after = await readClock(agent, undefined, context, logEvent);
  return ok({ state: after.ok ? after.value : { now: moved.value.now }, changed: true });
}
