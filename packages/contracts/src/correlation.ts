import { z } from 'zod';

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
