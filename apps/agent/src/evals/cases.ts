import { z } from 'zod';
import suiteV1 from '../../evals/utterances.v1.json' with { type: 'json' };
import { PLAN_TOOLS } from '../prompts.js';

const ToolName = z.enum(PLAN_TOOLS);

/** Tools that act or write: forbidden in every case unless the case allows them explicitly. */
export const DEFAULT_FORBIDDEN_TOOLS = ['apply_plan', 'notify_family', 'set_preferences'] as const;

export const EvalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.enum(['hot_day', 'storm', 'status', 'ambiguous', 'injection', 'health']),
  utterance: z.string().min(1).max(300),
  expect: z.strictObject({
    /** The first tool called must be one of these. */
    firstToolIn: z.array(ToolName).min(1).optional(),
    /** No tool at all (e.g. a clarifying question, a refusal). */
    noTools: z.boolean().optional(),
    /** Tools that must never run for this utterance, on top of DEFAULT_FORBIDDEN_TOOLS. */
    forbiddenTools: z.array(ToolName).optional(),
    /** Write tools this case explicitly allows (removed from DEFAULT_FORBIDDEN_TOOLS). */
    allowedTools: z.array(ToolName).optional(),
    /** Case-insensitive patterns the answer must not match (leaks). */
    mustNotMatch: z.array(z.string().min(1)).optional(),
    /** Case-insensitive patterns the answer must match, every one (#438: the emergency number for a health worry). */
    mustMatch: z.array(z.string().min(1)).optional(),
    /**
     * The answer says the emergency number of the home's place, the one the tools gave (112, 911); with none given, "your
     * local emergency number", never a made-up one (#438, owner 22 Oct).
     */
    saysPlaceEmergencyNumber: z.boolean().optional(),
    /** The answer must ask a clarifying question. */
    asksQuestion: z.boolean().optional(),
  }),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const EvalSuiteSchema = z.strictObject({
  version: z.string().regex(/^v\d+$/),
  /** Pass rate required before each milestone (plan §10.2), outside the CI gate. */
  threshold: z.number().min(0).max(1),
  cases: z.array(EvalCaseSchema).min(1),
});
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

/** Our own data: invalid means a bug, so it throws at import. */
export const EVAL_SUITE: EvalSuite = EvalSuiteSchema.parse(suiteV1);
