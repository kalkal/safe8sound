import { HouseholdSchema, err, ok, toolError, type ErrorEnvelope, type Household, type Result } from '@cold-reserve/contracts';
import { theRoom } from '@cold-reserve/core';
import { z } from 'zod';
import type { Agent, AgentAnswer } from './agent.js';
import { log as defaultLog, type Log } from '../log.js';
import { PHONE_FIXTURE_NAMES, phoneMessage } from '../phone/phone-fixtures.js';
import type { ScriptedPhone } from '../phone/phone-feed.js';
import { demoRoomNames } from './demo-rooms.js';
import { SCRIPT_FIXTURES, SCRIPT_FIXTURE_NAMES } from './script-fixtures.js';
import { createScriptedClock } from './scripted-clock.js';
import { createScriptedPlans, createScriptedPreferences, refuseAction, scriptedToolCall } from './scripted-tools.js';
import { StatusFactsSchema, type ToolName } from './wire.js';

const TOOL_NAMES = ['plan_comfort', 'apply_plan', 'get_reserve_outlook', 'get_preferences', 'get_safe_room_status', 'get_home_status'] as const satisfies readonly ToolName[];

// Deterministic answers from a versioned script file: no network, no LLM, no clock, no randomness.
// Used in every test and in CI (cost rule), and as the degraded mode when the remote agent is down.

const ScriptSchema = z
  .strictObject({
    version: z.literal(1),
    /** The fixed reading; its time is the scripted clock's, given when it is read (option B, 20 Oct). */
    status: StatusFactsSchema.omit({ ts: true }).optional(),
    entries: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-z0-9-]{1,40}$/),
          patterns: z.array(z.string().min(1).max(80)).min(1),
          text: z.string().min(1).max(600),
          withStatus: z.boolean(),
          /** Tool results to show as cards, by fixture name (see script-fixtures.ts). */
          cards: z.array(z.strictObject({ tool: z.enum(TOOL_NAMES), fixture: z.enum(SCRIPT_FIXTURE_NAMES) })).max(4).optional(),
          /** The entries whose proposal a bare yes ("yes", "ok", "sì") right after them confirms with this answer. */
          confirms: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).max(4).optional(),
          /** Family messages the scene sends with this answer, by fixture name (the phone, #24). */
          phone: z.array(z.strictObject({ fixture: z.enum(PHONE_FIXTURE_NAMES) })).max(3).optional(),
        }),
      )
      .min(1),
    /** The bare confirmations: a whole answer, never a word inside a question; they mean yes only right after a proposal. */
    yes: z.array(z.string().min(1).max(40)).max(20).optional(),
    fallback: z.string().min(1).max(600),
    /** Degraded mode: what to say for anything but a status question. Honest: nothing was done. */
    degradedFallback: z.string().min(1).max(600),
  })
  .superRefine((script, ctx) => {
    const ids = new Set(script.entries.map((entry) => entry.id));
    script.entries.forEach((entry, i) => {
      for (const id of entry.confirms ?? []) {
        if (!ids.has(id)) ctx.addIssue({ code: 'custom', path: ['entries', i, 'confirms'], message: `No entry "${id}" to confirm` });
      }
      if ((entry.withStatus || entry.text.includes('{soc}')) && script.status === undefined) {
        ctx.addIssue({ code: 'custom', path: ['entries', i], message: 'This entry needs the script status' });
      }
      entry.cards?.forEach((card, j) => {
        if (SCRIPT_FIXTURES[card.fixture]().tool !== card.tool) {
          ctx.addIssue({ code: 'custom', path: ['entries', i, 'cards', j], message: `Fixture "${card.fixture}" is not a ${card.tool} result` });
        }
      });
    });
  });
export type Script = z.infer<typeof ScriptSchema>;

/** Lowercase words separated by single spaces, padded so a pattern matches whole words only. */
const normalise = (text: string): string => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

export interface ScriptedAgentOptions {
  /**
   * As the degraded mode behind the remote agent: status answers only (entries `withStatus`, no card, no
   * family message). Every other entry speaks of an action, a plan or a card that the degraded mode never has,
   * so it gets the honest degraded answer instead: a failure is never reported as a success (#209).
   */
  degraded?: boolean;
  /** The simulated family phone: the scene's messages arrive there. */
  phone?: ScriptedPhone;
  /** Where a delivery is logged: code, correlation id and transition, never the text (it carries a name). */
  log?: Log;
}

export function createScriptedAgent(source: unknown, options: ScriptedAgentOptions = {}): Result<Agent, ErrorEnvelope> {
  const parsed = ScriptSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.').slice(0, 120), message: i.message.slice(0, 200) }));
    return err(toolError('invalid_config', 'The scripted answers file is invalid.', { details: { issues } }));
  }
  const script = parsed.data;
  const entries = script.entries
    .filter((entry) => options.degraded !== true || (entry.withStatus && entry.cards === undefined && entry.phone === undefined))
    .map((entry) => ({ ...entry, patterns: entry.patterns.map(normalise) }));
  const fallback = options.degraded === true ? script.degradedFallback : script.fallback;
  const yes = new Set((script.yes ?? []).map(normalise));
  /** The entry that gave the last answer: a bare yes confirms only what was just proposed. */
  let previous: string | undefined;
  // The simulated clock of the scripted home: the storm night's moments, the phone told on the way.
  const preferences = createScriptedPreferences();
  // Who is at home (set_scenario, as the sandbox's settings) and the safe room chosen in Settings name the room in every
  // text, card and family message (owner, 21 Oct): with no one at risk nothing says Leo.
  let household: Household = 'older-man';
  const room = () => ({ household, safeRoomId: preferences.read()?.preferences.safeRoomId ?? 'bedroom-1' });
  const message = (fixture: Parameters<typeof phoneMessage>[0]) => phoneMessage(fixture, room());
  // The plan the scripted home runs (owner, 21 Oct): a tap on Apply or "apply the plan" starts it; the storm replaces it.
  const plans = createScriptedPlans();
  const clock = createScriptedClock({ message, ...(options.phone === undefined ? {} : { phone: options.phone }) });
  /** The script's {safeRoom} as a noun phrase ("Leo's room", "the Study"), {SafeRoom} at the start of a sentence. */
  const withRoom = (text: string): string => {
    const { safeRoomId } = room();
    const phrase = theRoom(demoRoomNames(household)[safeRoomId] ?? safeRoomId);
    return text.replaceAll('{safeRoom}', phrase).replaceAll('{SafeRoom}', phrase.charAt(0).toUpperCase() + phrase.slice(1));
  };

  return ok({
    canCallTools: options.degraded !== true,
    callTool: (name, args, context) => {
      if (options.degraded === true) return Promise.resolve(refuseAction());
      const chosen = name === 'set_scenario' ? HouseholdSchema.safeParse(args['household']) : undefined;
      if (chosen?.success === true) household = chosen.data;
      const clocked = clock.call(name, args);
      if (clocked !== undefined) return Promise.resolve(clocked);
      const result = scriptedToolCall(name, args, clock.now(), preferences, plans, room());
      // The card says the family was told (familyAlert.sent): the scripted phone gets that message, as the server sends it.
      const alert = result.structuredContent?.['familyAlert'];
      const sent = typeof alert === 'object' && alert !== null && 'sent' in alert && typeof alert.sent === 'number' ? alert.sent : 0;
      if (result.isError !== true && sent > 0 && options.phone !== undefined) {
        const sent = message('last-resort');
        options.phone.deliver([sent]);
        (options.log ?? defaultLog)({ level: 'info', code: 'phone_delivered', correlationId: context.correlationId, details: { transition: sent.transition } });
      }
      return Promise.resolve(result);
    },
    ask: (question, context) => {
      const q = normalise(question);
      const after = previous;
      const confirmed = after !== undefined && yes.has(q) ? entries.find((e) => e.confirms?.includes(after) === true) : undefined;
      const entry = confirmed ?? entries.find((e) => e.patterns.some((p) => q.includes(p)));
      previous = entry?.id;
      if (entry === undefined) return Promise.resolve(ok({ text: fallback }));
      const { status } = script;
      const answer: AgentAnswer =
        entry.withStatus && status !== undefined ? { text: withRoom(entry.text).replaceAll('{soc}', String(status.batterySocPct)), status: { ...status, ts: clock.now() } } : { text: withRoom(entry.text) };
      if (entry.cards !== undefined) answer.cards = entry.cards.map((card) => SCRIPT_FIXTURES[card.fixture](household, room().safeRoomId));
      // The plan the scripted home runs: a plan applied by voice starts it, the storm replaces it (owner, 21 Oct).
      for (const card of answer.cards ?? []) if (card.tool === 'apply_plan') plans.apply(card.result.plan);
      if (entry.id === 'storm-start') plans.clear();
      // Fixed figures say they are an example, never a live reading (option B, 20 Oct).
      if (answer.status !== undefined || answer.cards !== undefined) answer.example = true;
      if (entry.phone !== undefined && options.phone !== undefined) {
        const messages = entry.phone.map((m) => message(m.fixture));
        options.phone.deliver(messages);
        for (const m of messages) (options.log ?? defaultLog)({ level: 'info', code: 'phone_delivered', correlationId: context.correlationId, details: { transition: m.transition } });
      }
      return Promise.resolve(ok(answer));
    },
  });
}
