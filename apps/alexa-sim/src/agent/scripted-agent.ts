import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';
import type { Agent, AgentAnswer } from './agent.js';
import { log as defaultLog, type Log } from '../log.js';
import { PHONE_FIXTURE_NAMES, phoneMessage } from '../phone/phone-fixtures.js';
import type { ScriptedPhone } from '../phone/phone-feed.js';
import { SCRIPT_FIXTURES, SCRIPT_FIXTURE_NAMES } from './script-fixtures.js';
import { createScriptedClock } from './scripted-clock.js';
import { createScriptedPreferences, refuseAction, scriptedToolCall } from './scripted-tools.js';
import { StatusFactsSchema, type ToolName } from './wire.js';

const TOOL_NAMES = ['plan_comfort', 'apply_plan', 'get_reserve_outlook', 'get_preferences', 'get_safe_room_status', 'get_home_status'] as const satisfies readonly ToolName[];

// Deterministic answers from a versioned script file: no network, no LLM, no clock, no randomness.
// Used in every test and in CI (cost rule), and as the degraded mode when the remote agent is down.

const ScriptSchema = z
  .strictObject({
    version: z.literal(1),
    status: StatusFactsSchema.optional(),
    entries: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-z0-9-]{1,40}$/),
          patterns: z.array(z.string().min(1).max(80)).min(1),
          text: z.string().min(1).max(600),
          withStatus: z.boolean(),
          /** Tool results to show as cards, by fixture name (see script-fixtures.ts). */
          cards: z.array(z.strictObject({ tool: z.enum(TOOL_NAMES), fixture: z.enum(SCRIPT_FIXTURE_NAMES) })).max(4).optional(),
          /** Family messages the scene sends with this answer, by fixture name (the phone, #24). */
          phone: z.array(z.strictObject({ fixture: z.enum(PHONE_FIXTURE_NAMES) })).max(3).optional(),
        }),
      )
      .min(1),
    fallback: z.string().min(1).max(600),
    /** Degraded mode: what to say for anything but a status question. Honest: nothing was done. */
    degradedFallback: z.string().min(1).max(600),
  })
  .superRefine((script, ctx) => {
    script.entries.forEach((entry, i) => {
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
  // The simulated clock of the scripted home: the storm night's moments, the phone told on the way.
  const preferences = createScriptedPreferences();
  const clock = createScriptedClock(options.phone === undefined ? {} : { phone: options.phone });

  return ok({
    canCallTools: options.degraded !== true,
    callTool: (name, args, context) => {
      if (options.degraded === true) return Promise.resolve(refuseAction());
      const clocked = clock.call(name, args);
      if (clocked !== undefined) return Promise.resolve(clocked);
      const result = scriptedToolCall(name, args, script.status?.ts, preferences);
      // The card says the family was told (familyAlert.sent): the scripted phone gets that message, as the server sends it.
      const alert = result.structuredContent?.['familyAlert'];
      const sent = typeof alert === 'object' && alert !== null && 'sent' in alert && typeof alert.sent === 'number' ? alert.sent : 0;
      if (result.isError !== true && sent > 0 && options.phone !== undefined) {
        const message = phoneMessage('last-resort');
        options.phone.deliver([message]);
        (options.log ?? defaultLog)({ level: 'info', code: 'phone_delivered', correlationId: context.correlationId, details: { transition: message.transition } });
      }
      return Promise.resolve(result);
    },
    ask: (question, context) => {
      const q = normalise(question);
      const entry = entries.find((e) => e.patterns.some((p) => q.includes(p)));
      if (entry === undefined) return Promise.resolve(ok({ text: fallback }));
      const { status } = script;
      const answer: AgentAnswer =
        entry.withStatus && status !== undefined ? { text: entry.text.replaceAll('{soc}', String(status.batterySocPct)), status } : { text: entry.text };
      if (entry.cards !== undefined) answer.cards = entry.cards.map((card) => SCRIPT_FIXTURES[card.fixture]());
      if (entry.phone !== undefined && options.phone !== undefined) {
        const messages = entry.phone.map((m) => phoneMessage(m.fixture));
        options.phone.deliver(messages);
        for (const m of messages) (options.log ?? defaultLog)({ level: 'info', code: 'phone_delivered', correlationId: context.correlationId, details: { transition: m.transition } });
      }
      return Promise.resolve(ok(answer));
    },
  });
}
