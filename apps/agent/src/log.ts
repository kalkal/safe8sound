import type { ErrorEnvelope, LogEntry } from '@cold-reserve/contracts';

/**
 * One agent log line: the shared LogEntry of L1 (#111, moved here in #143), the same JSON as the MCP server
 * and sim-api. The code, the category and the error type; never the error's own text (it may hold internals).
 */
export type AgentLogEntry = LogEntry;

/**
 * What a log line may say about the error behind a failure (#199): its name and the HTTP status the AWS SDK
 * reports (`$metadata.httpStatusCode`). Never its message, ARNs, account or request ids: names and codes only.
 */
function causeDetails(cause: unknown): { causeName?: string; httpStatus?: number } {
  if (!(cause instanceof Error)) return {};
  const status = (cause as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return { causeName: cause.name, ...(typeof status === 'number' ? { httpStatus: status } : {}) };
}

export function logLine(
  error: ErrorEnvelope,
  errorName: string,
  extra: { correlationId?: string | undefined; httpStatus?: number | undefined; cause?: unknown } = {},
): AgentLogEntry {
  const cause = causeDetails(extra.cause);
  const httpStatus = extra.httpStatus ?? cause.httpStatus;
  const details = { ...(httpStatus === undefined ? {} : { httpStatus }), ...(cause.causeName === undefined ? {} : { causeName: cause.causeName }) };
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
    // HTTP status when the MCP server or the AWS SDK answered with one (401, 503, ...), and the name of the
    // error a wrapper (Strands' ModelError) hides: enough to diagnose from the logs alone (#199).
    ...(Object.keys(details).length === 0 ? {} : { details }),
  };
}
