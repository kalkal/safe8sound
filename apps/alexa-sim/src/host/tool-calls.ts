import { ApplyPlanInputSchema, ApplyPlanOutputSchema, ErrorEnvelopeSchema, SetPreferencesInputSchema, err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import type { z } from 'zod';
import { toolErrorResult, type Agent, type ToolCallResult } from '../agent/agent.js';
import type { ToolCard } from '../agent/wire.js';
import type { Log } from '../log.js';

// A card may ask the host to call a tool (MCP Apps tools/call). A card is untrusted content: each card
// may call only the tool behind its own action, on its own data, with contract-checked arguments.

export type CardToolCall =
  | { name: 'apply_plan'; args: z.infer<typeof ApplyPlanInputSchema> }
  | { name: 'set_preferences'; args: z.infer<typeof SetPreferencesInputSchema> };

/**
 * The second yes to a last resort by touch (#160; it deliberately updates the #168 rule that a card could
 * never send a token): the host keeps the token the first step returned to this same frame, and accepts only
 * that token, once, for that plan. The token is never shown or logged. `sending`: a second yes is on its way; the
 * token is spent only when the server answers, so a call the network lost can be tapped again.
 */
export interface FrameConfirmation {
  pending: { planId: string; token: string; sending?: boolean } | undefined;
}

export const createFrameConfirmation = (): FrameConfirmation => ({ pending: undefined });

/**
 * A frame's confirmation from the card it shows (#215 review): the confirmation card of a spoken first yes is
 * born with its token, so the host holds that token as the frame's pending confirmation, for its one tap.
 */
export function confirmationFor(card: ToolCard): FrameConfirmation {
  if (card.tool !== 'apply_plan' || card.result.confirmation === undefined) return createFrameConfirmation();
  return { pending: { planId: card.result.plan.id, token: card.result.confirmation.token } };
}

/** The second yes: only the token this frame holds, for its plan, one call at a time (a replay never reaches the server). */
function acceptsToken(planId: string, token: string, confirmation: FrameConfirmation | undefined): boolean {
  const pending = confirmation?.pending;
  if (pending === undefined || pending.planId !== planId || pending.token !== token || pending.sending === true) return false;
  pending.sending = true;
  return true;
}

/**
 * After a second yes: an answer from the server spends the token (applied, or refused for good); a call that never
 * got one (thrown, or a retryable error) keeps it for the next tap.
 */
function settleToken(confirmation: FrameConfirmation | undefined, result: ToolCallResult | undefined): void {
  const pending = confirmation?.pending;
  if (confirmation === undefined || pending?.sending !== true) return;
  const envelope = result?.isError === true ? ErrorEnvelopeSchema.safeParse(result.structuredContent) : undefined;
  const lost = result === undefined || (envelope?.success === true && envelope.data.retryable);
  if (lost) pending.sending = false;
  else confirmation.pending = undefined;
}

const refuse = (message: string): Result<never, ErrorEnvelope> => err(toolError('invalid_input', message, { details: { field: 'name' } }));

export function readToolCall(
  params: { name: string; arguments?: Record<string, unknown> | undefined },
  card: ToolCard,
  confirmation?: FrameConfirmation,
): Result<CardToolCall, ErrorEnvelope> {
  const args = params.arguments ?? {};
  if (card.tool === 'plan_comfort' && params.name === 'apply_plan') {
    // A refused plan (#186) has nothing to apply.
    if (!('id' in card.result)) return refuse('A refused plan cannot be applied.');
    const parsed = ApplyPlanInputSchema.safeParse(args);
    // The plan card applies its own plan, never another one.
    if (!parsed.success || parsed.data.planId !== card.result.id) return refuse('This card may only apply its own plan.');
    const token = parsed.data.lastResortToken;
    if (token !== undefined && !acceptsToken(parsed.data.planId, token, confirmation)) {
      return refuse('This card may only confirm a last-resort plan with the confirmation it was given.');
    }
    return ok({ name: 'apply_plan', args: parsed.data });
  }
  // The confirmation card (a spoken first yes, #215): only its own second yes, with the token it was born with.
  if (card.tool === 'apply_plan' && params.name === 'apply_plan') {
    const parsed = ApplyPlanInputSchema.safeParse(args);
    const token = parsed.success ? parsed.data.lastResortToken : undefined;
    if (!parsed.success || token === undefined || !acceptsToken(parsed.data.planId, token, confirmation)) {
      return refuse('This card may only confirm its own last-resort plan.');
    }
    return ok({ name: 'apply_plan', args: parsed.data });
  }
  if (card.tool === 'get_preferences' && params.name === 'set_preferences') {
    const parsed = SetPreferencesInputSchema.safeParse(args);
    if (!parsed.success) return refuse('The card sent invalid preferences.');
    return ok({ name: 'set_preferences', args: parsed.data });
  }
  return refuse(`This card may not call ${params.name}.`);
}

export interface CardCallDeps {
  agent: Agent;
  /** The turn that showed the card: its actions share the turn's correlation id. */
  turnId: string;
  log: Log;
  /** This frame's pending last-resort confirmation; without it a card can never send a token. */
  confirmation?: FrameConfirmation;
}

/** Answers a card's tools/call: refused outside its binding, never thrown, every failure logged. */
export async function answerCardCall(
  params: { name: string; arguments?: Record<string, unknown> | undefined },
  card: ToolCard,
  { agent, turnId, log, confirmation }: CardCallDeps,
): Promise<ToolCallResult> {
  const call = readToolCall(params, card, confirmation);
  if (!call.ok) {
    log({ level: 'warn', code: call.error.code, correlationId: turnId, details: { tool: params.name, card: card.tool } });
    return toolErrorResult(call.error);
  }
  try {
    const result = await agent.callTool(call.value.name, call.value.args, { correlationId: turnId });
    settleToken(confirmation, result);
    if (result.isError === true) {
      // The card shows the answer as it is; the log keeps the code for the turn.
      const envelope = ErrorEnvelopeSchema.safeParse(result.structuredContent);
      log({ level: 'warn', code: envelope.success ? envelope.data.code : 'output_schema_violation', correlationId: turnId, details: { tool: params.name } });
    } else if (confirmation !== undefined && call.value.name === 'apply_plan') {
      // The first step of a last resort: keep its token for this frame's second yes.
      const applied = ApplyPlanOutputSchema.safeParse(result.structuredContent);
      const issued = applied.success ? applied.data.confirmation : undefined;
      if (issued !== undefined && applied.success) confirmation.pending = { planId: applied.data.plan.id, token: issued.token };
    }
    return result;
  } catch (error) {
    settleToken(confirmation, undefined);
    log({ level: 'error', code: 'unexpected_error', correlationId: turnId, error, details: { tool: params.name } });
    return toolErrorResult(toolError('unexpected_error', 'Something went wrong: nothing was changed.'));
  }
}
