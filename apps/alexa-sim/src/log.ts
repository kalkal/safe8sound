import { ERROR_CATALOG, categoryOf, type ErrorCategory, type ErrorCode, type ErrorEnvelope } from '@cold-reserve/contracts';
import type { VoiceFailure } from './machine.js';

// One JSON line per event, in the fields of the shared log entry (docs/error-handling.md §6.1).
// TODO(audit L1): replace with the shared logger port once it lands in contracts/core.
// The browser never logs an error message or a stack: they can carry what the user typed.

export interface LogEvent {
  level: 'error' | 'warn' | 'info';
  /** A catalog code, or a host-only event name (frame_message_rejected). */
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

export function createLogger(component: string, write: (line: string, level: LogEvent['level']) => void, now = () => new Date().toISOString()): Log {
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

export const log: Log = createLogger('alexa-sim', toConsole);

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

/** A configuration error: which settings are wrong (their paths), never the values or the messages. */
export function configErrorEvent(error: ErrorEnvelope): LogEvent {
  return { level: 'error', code: error.code, details: { step: 'config', issues: (error.details?.issues ?? []).map((issue) => issue.path) } };
}

/** A voice failure (#25): its code and phase, the turn when there is one; never what was said. */
export function voiceFailureEvent({ code, phase, turnId }: VoiceFailure): LogEvent {
  return { level: 'warn', code, ...(turnId !== null && { correlationId: turnId }), details: { phase } };
}
