import { ApplyPlanInputSchema, SetPreferencesInputSchema, err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import type { z } from 'zod';
import { toolErrorResult, type Agent, type ToolCallResult } from '../agent/agent.js';
import type { ToolCard } from '../agent/wire.js';
import type { Log } from '../log.js';

// A card may ask the host to call a tool (MCP Apps tools/call). A card is untrusted content: each card
// may call only the tool behind its own action, on its own data, with contract-checked arguments.

export type CardToolCall =
  | { name: 'apply_plan'; args: z.infer<typeof ApplyPlanInputSchema> }
  | { name: 'set_preferences'; args: z.infer<typeof SetPreferencesInputSchema> };

const refuse = (message: string): Result<never, ErrorEnvelope> => err(toolError('invalid_input', message, { details: { field: 'name' } }));

export function readToolCall(params: { name: string; arguments?: Record<string, unknown> | undefined }, card: ToolCard): Result<CardToolCall, ErrorEnvelope> {
  const args = params.arguments ?? {};
  if (card.tool === 'plan_comfort' && params.name === 'apply_plan') {
    const parsed = ApplyPlanInputSchema.safeParse(args);
    // The plan card applies its own plan, never another one.
    if (!parsed.success || parsed.data.planId !== card.result.id) return refuse('This card may only apply its own plan.');
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
}

/** Answers a card's tools/call: refused outside its binding, never thrown, every failure logged. */
export async function answerCardCall(
  params: { name: string; arguments?: Record<string, unknown> | undefined },
  card: ToolCard,
  { agent, turnId, log }: CardCallDeps,
): Promise<ToolCallResult> {
  const call = readToolCall(params, card);
  if (!call.ok) {
    log({ level: 'warn', code: call.error.code, correlationId: turnId, details: { tool: params.name, card: card.tool } });
    return toolErrorResult(call.error);
  }
  try {
    return await agent.callTool(call.value.name, call.value.args, { correlationId: turnId });
  } catch (error) {
    log({ level: 'error', code: 'unexpected_error', correlationId: turnId, error, details: { tool: params.name } });
    return toolErrorResult(toolError('unexpected_error', 'Something went wrong: nothing was changed.'));
  }
}
