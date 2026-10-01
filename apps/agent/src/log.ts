import type { ErrorEnvelope, LogEntry } from '@cold-reserve/contracts';

/**
 * One agent log line: the shared LogEntry of L1 (#111, moved here in #143), the same JSON as the MCP server
 * and sim-api. The code, the category and the error type; never the error's own text (it may hold internals).
 */
export type AgentLogEntry = LogEntry;

export function logLine(error: ErrorEnvelope, errorName: string, extra: { correlationId?: string | undefined; httpStatus?: number | undefined } = {}): AgentLogEntry {
  return {
    ts: new Date().toISOString(),
    level: error.category === 'internal' ? 'error' : 'warn',
    component: 'agent',
    message: error.code,
    // The id of the user turn, from sim-api: the same at every hop; `none` outside a turn.
    correlationId: extra.correlationId ?? 'none',
    code: error.code,
    category: error.category,
    errorName,
    // HTTP status when the MCP server answered with one (401, 503, ...).
    ...(extra.httpStatus === undefined ? {} : { details: { httpStatus: extra.httpStatus } }),
  };
}
