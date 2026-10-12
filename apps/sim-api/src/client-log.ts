import { CorrelationIdSchema, ErrorCategorySchema, ErrorCodeSchema, IsoDateTimeSchema, categoryOf, type LogEntry } from '@cold-reserve/contracts';
import { z } from 'zod';

// POST /v1/log (#125, plan §10.7): the browser's warnings and errors reach the server log, in the shared line of
// L1 (#111). Stricter than LogEntrySchema: a browser may say which code, which turn and short identifiers, never
// free text, a stack, a home id or a client id. A bad line refuses the whole batch; the browser then drops it.

/** Lines per request: the browser sends at most this many at once. */
export const CLIENT_LOG_MAX_LINES = 10;
/** The route's own body cap, below the other routes' (ten lines with their details fit in it). */
export const CLIENT_LOG_MAX_BODY_BYTES = 8192;

/** An identifier, a path or a number as text: no spaces (no sentence fits) and no `#` (no sandbox id `demo#...`). */
const Token = z.string().max(64).regex(/^[A-Za-z0-9_.:/-]*$/);
const DetailValue = z.union([z.boolean(), z.number(), Token, z.array(Token).max(16)]);
const Details = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/), DetailValue).refine((d) => Object.keys(d).length <= 8, { message: 'At most 8 details' });

const ClientLogLineSchema = z
  .strictObject({
    ts: IsoDateTimeSchema,
    /** Warnings and errors only: info lines stay in the browser console. */
    level: z.enum(['warn', 'error']),
    component: z.enum(['alexa-sim', 'ui-cards']),
    /** The event name, never a sentence. */
    message: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    correlationId: CorrelationIdSchema,
    code: ErrorCodeSchema,
    category: ErrorCategorySchema,
    errorName: z
      .string()
      .regex(/^[A-Za-z_$][A-Za-z0-9_$.]{0,79}$/)
      .optional(),
    details: Details.optional(),
  })
  .refine((line) => categoryOf(line.code) === line.category, { message: 'The category is the one the catalogue gives the code', path: ['category'] });

export const ClientLogRequestSchema = z.strictObject({ lines: z.array(ClientLogLineSchema).min(1).max(CLIENT_LOG_MAX_LINES) });
export type ClientLogRequest = z.infer<typeof ClientLogRequestSchema>;

/**
 * The server lines of one accepted batch: the server's time (the browser's goes under details), the browser's
 * correlation id, the demo code id, and the home only as "sandbox" (a sandbox id never enters a log line).
 */
export function clientLogEntries(request: ClientLogRequest, ctx: { nowIso: string; codeId: string }): LogEntry[] {
  return request.lines.map(({ ts, details, ...line }) => ({
    ...line,
    ts: ctx.nowIso,
    details: { ...details, via: 'log_route', clientTs: ts, codeId: ctx.codeId, home: 'sandbox' },
  }));
}
