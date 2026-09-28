import { z } from 'zod';
import { PlanSchema, type Plan } from './plan.js';

export type CardState =
  | { kind: 'waiting' }
  | { kind: 'plan'; plan: Plan }
  | { kind: 'error'; message: string; retryable: boolean };

export interface ToolResultLike {
  isError?: boolean | undefined;
  content: unknown[];
  structuredContent?: unknown;
}

const EnvelopeSchema = z.object({ message: z.string().min(1), retryable: z.boolean() });

const GENERIC_MESSAGE = 'The plan could not be prepared.';

/** Turns a plan_comfort result into what the card shows; never trusts unvalidated content. */
export function parseToolResult(result: ToolResultLike): CardState {
  if (result.isError) {
    const envelope = EnvelopeSchema.safeParse(result.structuredContent);
    return envelope.success
      ? { kind: 'error', message: envelope.data.message, retryable: envelope.data.retryable }
      : { kind: 'error', message: GENERIC_MESSAGE, retryable: false };
  }
  const plan = PlanSchema.safeParse(result.structuredContent);
  if (!plan.success) {
    // Contract drift between server and card: show a calm error, report it on the console for Diagnostics.
    console.warn(JSON.stringify({ level: 'warn', component: 'plan-card', code: 'invalid_card_data', issues: plan.error.issues.length }));
    return { kind: 'error', message: GENERIC_MESSAGE, retryable: false };
  }
  return { kind: 'plan', plan: plan.data };
}
