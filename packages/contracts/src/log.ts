import { z } from 'zod';
import { HomeIdSchema, IsoDateTimeSchema } from './common.js';
import { ErrorCategorySchema, ErrorCodeSchema, categoryOf } from './errors.js';

// One log line for every component (docs/error-handling.md §6.1, audit L1, approved in #111): the MCP
// server, the agent, sim-api, the store and the browser write the same JSON, so one query on the correlation
// id follows a request across them. Never secrets or personal data: the schema is strict, so a field nobody
// declared cannot slip in.

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const LogEntrySchema = z
  .strictObject({
    ts: IsoDateTimeSchema,
    level: LogLevelSchema,
    /** Who writes it: `mcp-server`, `store-dynamodb`, `agent`, `sim-api`, `web`... */
    component: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    message: z.string().min(1).max(500),
    correlationId: z.string().min(1).max(128),
    /** Required on warnings and errors: the catalogue code, and its category. */
    code: ErrorCodeSchema.optional(),
    category: ErrorCategorySchema.optional(),
    homeId: HomeIdSchema.optional(),
    clientId: z.string().min(1).max(64).optional(),
    /** The name of the cause (`TimeoutError`, `ConditionalCheckFailedException`), never its full text. */
    errorName: z.string().min(1).max(80).optional(),
    /** Server side only: `withoutStack` before a line leaves the server. */
    stack: z.string().max(4000).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((e, ctx) => {
    if ((e.level === 'warn' || e.level === 'error') && (e.code === undefined || e.category === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['code'], message: 'A warning or an error names its code and category' });
    }
    if (e.code !== undefined && e.category !== undefined && categoryOf(e.code) !== e.category) {
      ctx.addIssue({ code: 'custom', path: ['category'], message: 'The category is the one the catalogue gives the code' });
    }
  });
export type LogEntry = z.infer<typeof LogEntrySchema>;

/** The same line without the stack: what may reach a browser or a client. */
export function withoutStack(entry: LogEntry): Omit<LogEntry, 'stack'> {
  const copy: LogEntry = { ...entry };
  delete copy.stack;
  return copy;
}
