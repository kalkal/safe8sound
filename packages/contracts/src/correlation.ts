import { z } from 'zod';
import { toolError, type ErrorEnvelope } from './errors.js';
import { err, ok, type Result } from './result.js';

// One definition of the correlation id (audit R12, #111): every HTTP hop (simulator → sim-api → agent → MCP
// server) carries it in the same header, and every log line names it. Contracts stay a leaf, so a fresh id
// comes from the caller (`randomUUID` on Node, `crypto.randomUUID` in the browser).

export const CORRELATION_ID_HEADER = 'x-correlation-id';

export const CorrelationIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export type CorrelationId = z.infer<typeof CorrelationIdSchema>;

/** The id the caller presented when it is a well-formed UUID; otherwise a fresh one. */
export function correlationIdFrom(presented: string | null | undefined, fresh: () => string): string {
  return presented !== null && presented !== undefined && CorrelationIdSchema.safeParse(presented).success ? presented : fresh();
}

/**
 * The turn of the conversation an MCP call belongs to (#230, additive, approved in #230): the agent sends the
 * turn's correlation id in this header on every MCP call of a turn; a card tap (sim-api, the host) never does.
 * apply_plan in the turn that proposed the plan is refused: the person has not answered yet.
 */
export const TURN_HEADER = 'x-cold-reserve-turn';

/** The turn id the caller presented: a well-formed UUID, or none; a malformed one is refused, never ignored. */
export function turnIdFrom(presented: string | null | undefined): Result<CorrelationId | undefined, ErrorEnvelope> {
  if (presented === null || presented === undefined) return ok(undefined);
  return CorrelationIdSchema.safeParse(presented).success ? ok(presented) : err(toolError('invalid_input', `The ${TURN_HEADER} header is not a turn id.`));
}
