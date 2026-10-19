import {
  ReserveOutlookSchema,
  SafeRoomStatusSchema,
  err,
  ok,
  toolError,
  type ErrorEnvelope,
  type ReserveOutlook,
  type Result,
  type SafeRoomStatus,
} from '@cold-reserve/contracts';
import type { ZodType } from 'zod';
import type { Agent, AskContext } from '../agent/agent.js';
import { log as defaultLog, type Log } from '../log.js';

// The idle screen's own readings (owner, 11 Oct; #432 S6): the reserve's ice cubes (get_reserve_outlook) and Leo's
// room with the time it stays safe until (get_safe_room_status), read on load and when the home, the scenario or the
// simulated time changes, never polled. A failure is a quiet degraded mode: the tile is hidden and one structured line
// is logged, with the correlation id, the step and nothing of the home.

async function readIdleTool<T>(
  o: { tool: 'get_reserve_outlook' | 'get_safe_room_status'; schema: ZodType<T>; step: string; what: string },
  agent: Agent,
  context: AskContext,
  logEvent: Log,
): Promise<Result<T, ErrorEnvelope>> {
  let failure: ErrorEnvelope;
  try {
    const reply = await agent.callTool(o.tool, {}, context);
    const parsed = reply.isError === true ? undefined : o.schema.safeParse(reply.structuredContent);
    if (parsed?.success === true) return ok(parsed.data);
    failure = reply.isError === true ? toolError('agent_unavailable', `${o.what} could not be read.`) : toolError('output_schema_violation', `${o.what} came back in an unexpected format.`);
  } catch (error) {
    failure = toolError('agent_unavailable', `${o.what} could not be read.`);
    logEvent({ level: 'warn', code: failure.code, correlationId: context.correlationId, error, details: { step: o.step } });
    return err(failure);
  }
  logEvent({ level: 'warn', code: failure.code, correlationId: context.correlationId, details: { step: o.step } });
  return err(failure);
}

export function fetchReserve(agent: Agent, context: AskContext, logEvent: Log = defaultLog): Promise<Result<ReserveOutlook, ErrorEnvelope>> {
  return readIdleTool({ tool: 'get_reserve_outlook', schema: ReserveOutlookSchema, step: 'reserve_clock', what: 'The reserve' }, agent, context, logEvent);
}

export function fetchSafeRoom(agent: Agent, context: AskContext, logEvent: Log = defaultLog): Promise<Result<SafeRoomStatus, ErrorEnvelope>> {
  return readIdleTool({ tool: 'get_safe_room_status', schema: SafeRoomStatusSchema, step: 'safe_room_tile', what: 'The safe room' }, agent, context, logEvent);
}
