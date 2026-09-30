import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';
import type { Agent, AgentAnswer } from './agent.js';
import { SCRIPT_FIXTURES, SCRIPT_FIXTURE_NAMES } from './script-fixtures.js';
import { StatusFactsSchema, type ToolName } from './wire.js';

const TOOL_NAMES = ['plan_comfort', 'apply_plan', 'get_reserve_outlook', 'get_preferences'] as const satisfies readonly ToolName[];

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
   * As the degraded mode behind the remote agent: status answers only. Entries that show a card (a plan,
   * an applied plan, preferences) are never used, so a failure can never be reported as a success.
   */
  degraded?: boolean;
}

export function createScriptedAgent(source: unknown, options: ScriptedAgentOptions = {}): Result<Agent, ErrorEnvelope> {
  const parsed = ScriptSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.').slice(0, 120), message: i.message.slice(0, 200) }));
    return err(toolError('invalid_config', 'The scripted answers file is invalid.', { details: { issues } }));
  }
  const script = parsed.data;
  const entries = script.entries
    .filter((entry) => options.degraded !== true || entry.cards === undefined)
    .map((entry) => ({ ...entry, patterns: entry.patterns.map(normalise) }));
  const fallback = options.degraded === true ? script.degradedFallback : script.fallback;

  return ok({
    ask: (question) => {
      const q = normalise(question);
      const entry = entries.find((e) => e.patterns.some((p) => q.includes(p)));
      if (entry === undefined) return Promise.resolve(ok({ text: fallback }));
      const { status } = script;
      const answer: AgentAnswer =
        entry.withStatus && status !== undefined ? { text: entry.text.replaceAll('{soc}', String(status.batterySocPct)), status } : { text: entry.text };
      if (entry.cards !== undefined) answer.cards = entry.cards.map((card) => SCRIPT_FIXTURES[card.fixture]());
      return Promise.resolve(ok(answer));
    },
  });
}
