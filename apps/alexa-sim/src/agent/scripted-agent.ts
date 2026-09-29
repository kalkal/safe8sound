import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';
import type { Agent } from './agent.js';
import { StatusFactsSchema } from './wire.js';

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
        }),
      )
      .min(1),
    fallback: z.string().min(1).max(600),
  })
  .superRefine((script, ctx) => {
    script.entries.forEach((entry, i) => {
      if ((entry.withStatus || entry.text.includes('{soc}')) && script.status === undefined) {
        ctx.addIssue({ code: 'custom', path: ['entries', i], message: 'This entry needs the script status' });
      }
    });
  });
export type Script = z.infer<typeof ScriptSchema>;

/** Lowercase words separated by single spaces, padded so a pattern matches whole words only. */
const normalise = (text: string): string => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

export function createScriptedAgent(source: unknown): Result<Agent, ErrorEnvelope> {
  const parsed = ScriptSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.').slice(0, 120), message: i.message.slice(0, 200) }));
    return err(toolError('invalid_config', 'The scripted answers file is invalid.', { details: { issues } }));
  }
  const script = parsed.data;
  const entries = script.entries.map((entry) => ({ ...entry, patterns: entry.patterns.map(normalise) }));

  return ok({
    ask: (question) => {
      const q = normalise(question);
      const entry = entries.find((e) => e.patterns.some((p) => q.includes(p)));
      if (entry === undefined) return Promise.resolve(ok({ text: script.fallback }));
      const { status } = script;
      if (!entry.withStatus || status === undefined) return Promise.resolve(ok({ text: entry.text }));
      return Promise.resolve(ok({ text: entry.text.replaceAll('{soc}', String(status.batterySocPct)), status }));
    },
  });
}
