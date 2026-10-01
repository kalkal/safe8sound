import type { ErrorCategory, ErrorEnvelope } from '@cold-reserve/contracts';

/**
 * One line of the error log, in the mcp-server shape (docs/error-handling.md §6.1) until L1 brings
 * the shared logger: the code, the category and the error type, never the message (it may hold internals).
 */
export interface AgentLogEntry {
  readonly ts: string;
  readonly level: 'warn' | 'error';
  readonly component: 'agent';
  readonly code: ErrorEnvelope['code'];
  readonly category: ErrorCategory;
  /** The id of the user turn, from sim-api: the same at every hop. */
  readonly correlationId?: string;
  readonly errorName: string;
  /** HTTP status when the MCP server answered with one (401, 503, ...). */
  readonly httpStatus?: number;
}

export function logLine(error: ErrorEnvelope, errorName: string, extra: { correlationId?: string | undefined; httpStatus?: number | undefined } = {}): AgentLogEntry {
  return {
    ts: new Date().toISOString(),
    level: error.category === 'internal' ? 'error' : 'warn',
    component: 'agent',
    code: error.code,
    category: error.category,
    ...(extra.correlationId === undefined ? {} : { correlationId: extra.correlationId }),
    errorName,
    ...(extra.httpStatus === undefined ? {} : { httpStatus: extra.httpStatus }),
  };
}
