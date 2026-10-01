import { ERROR_CATALOG, categoryOf, type ErrorCategory, type ErrorCode } from '@cold-reserve/contracts';

// One JSON line per event, in the fields of the shared log entry (docs/error-handling.md §6.1), as the host logs them.
// TODO(audit L1): replace with the shared logger port once it lands in contracts/core.
// The browser never logs an error message or a stack: they can carry what the user typed.

export interface LogEvent {
  level: 'error' | 'warn' | 'info';
  /** A catalog code, or a host-only event name (a card-only event). */
  code: ErrorCode | (string & {});
  correlationId?: string;
  /** Only its name is logged. */
  error?: unknown;
  details?: Record<string, unknown>;
}

export interface LogLine {
  ts: string;
  level: LogEvent['level'];
  component: string;
  code: string;
  category?: ErrorCategory;
  correlationId?: string;
  errorName?: string;
  details?: Record<string, unknown>;
}

export type Log = (event: LogEvent) => void;

const isCatalogCode = (code: string): code is ErrorCode => Object.hasOwn(ERROR_CATALOG, code);
const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

export function createCardLogger(write: (line: string, level: LogEvent['level']) => void, now = () => new Date().toISOString()): Log {
  const component = 'ui-cards';
  return ({ level, code, correlationId, error, details }) => {
    const line: LogLine = {
      ts: now(),
      level,
      component,
      code,
      ...(isCatalogCode(code) && { category: categoryOf(code) }),
      ...(correlationId !== undefined && { correlationId }),
      ...(error !== undefined && { errorName: errorName(error) }),
      ...(details !== undefined && { details }),
    };
    write(JSON.stringify(line), level);
  };
}

const toConsole = (line: string, level: LogEvent['level']) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
};

export const log: Log = createCardLogger(toConsole);

/** The last net (error-handling §3): what no code path caught still leaves a line. Returns the remover. */
export function logUnhandled(target: EventTarget, logEvent: Log = log): () => void {
  const onRejection = (event: Event) => {
    logEvent({ level: 'error', code: 'unexpected_error', error: (event as Event & { reason?: unknown }).reason, details: { source: 'unhandledrejection' } });
  };
  const onError = (event: Event) => {
    logEvent({ level: 'error', code: 'unexpected_error', error: (event as Event & { error?: unknown }).error, details: { source: 'error' } });
  };
  target.addEventListener('unhandledrejection', onRejection);
  target.addEventListener('error', onError);
  return () => {
    target.removeEventListener('unhandledrejection', onRejection);
    target.removeEventListener('error', onError);
  };
}
