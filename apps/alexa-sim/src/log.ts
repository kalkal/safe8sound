import { ERROR_CATALOG, categoryOf, type ErrorCode, type ErrorEnvelope, type LogEntry } from '@cold-reserve/contracts';
import { causeFields, loggerTo, type LogSink } from '@cold-reserve/core';
import type { VoiceFailure } from './machine.js';

// The browser writes the shared log line of L1 (#111, #143) through the shared Logger port: one LogEntry per
// event, to the console and, in remote mode, to sim-api's POST /v1/log (#125, remote-log.ts).
// The browser never logs an error message or a stack: they can carry what the user typed.

/**
 * Host events that are not catalog codes, and the catalog code their warning is logged under (a warning or an
 * error names its code and category, LogEntrySchema). The event name stays the line's message.
 */
export const HOST_EVENT_CODES = {
  /** A card frame sent a message the host refused. */
  frame_message_rejected: 'invalid_input',
  /** The answer named a card this host cannot show. */
  unknown_card: 'output_schema_violation',
  phone_inbox_timeout: 'agent_timeout',
  phone_inbox_unreachable: 'agent_unavailable',
  phone_reply_timeout: 'agent_timeout',
  phone_reply_unreachable: 'agent_unavailable',
  /** The studio voice (Polly) did not play: the browser voice reads the reply instead. */
  speech_timeout: 'polly_unavailable',
  speech_playback_failed: 'polly_unavailable',
  /** The browser's storage (the saved language) could not be read or written. */
  storage_unavailable: 'store_unavailable',
} as const satisfies Record<string, ErrorCode>;
export type HostEvent = keyof typeof HOST_EVENT_CODES;

interface EventFields {
  correlationId?: string;
  /** Only its name is logged. */
  error?: unknown;
  details?: Record<string, unknown>;
}

/**
 * A catalog code, a mapped host event, or (info lines, or a code a server answered) any event name. A warning or
 * an error with a code that is neither is logged as `unexpected_error`, the event name kept as the message.
 */
export interface LogEvent extends EventFields {
  level: 'error' | 'warn' | 'info';
  code: ErrorCode | HostEvent | (string & {});
}

export type Log = (event: LogEvent) => void;

const isCatalogCode = (code: string): code is ErrorCode => Object.hasOwn(ERROR_CATALOG, code);
const isHostEvent = (code: string): code is HostEvent => Object.hasOwn(HOST_EVENT_CODES, code);

function codeOf(code: string): ErrorCode | undefined {
  if (isCatalogCode(code)) return code;
  return isHostEvent(code) ? HOST_EVENT_CODES[code] : undefined;
}

/**
 * A Log writing LogEntry lines to `sink`. A line without a turn carries the page's id, so every line of one
 * page can be followed together. A sink that throws never breaks the caller (the shared `loggerTo`).
 */
export function createLogger(component: string, sink: LogSink, opts: { now?: () => string; pageId: string }): Log {
  const logger = loggerTo(sink);
  const now = opts.now ?? (() => new Date().toISOString());
  return ({ level, code, correlationId, error, details }) => {
    // A warning always names a catalog code: an unknown one is a bug of ours or of a server.
    const catalog = codeOf(code) ?? (level === 'info' ? undefined : 'unexpected_error');
    const entry: LogEntry = {
      ts: now(),
      level,
      component,
      message: code,
      correlationId: correlationId ?? opts.pageId,
      ...(catalog !== undefined && { code: catalog, category: categoryOf(catalog) }),
      ...(error !== undefined && { errorName: causeFields(error, { withStack: false }).errorName }),
      ...(details !== undefined && { details }),
    };
    logger.log(entry);
  };
}

/** The browser console, one JSON line per entry. */
export const consoleSink: LogSink = (entry) => {
  const line = JSON.stringify(entry);
  if (entry.level === 'error') console.error(line);
  else if (entry.level === 'warn') console.warn(line);
  else console.info(line);
};

const sinks = new Set<LogSink>([consoleSink]);

/** Adds a sink (the remote one, in remote mode); returns its remover. Each sink fails on its own. */
export function addLogSink(sink: LogSink): () => void {
  const logger = loggerTo(sink);
  const safe: LogSink = (entry) => {
    logger.log(entry);
  };
  sinks.add(safe);
  return () => sinks.delete(safe);
}

/** The id of this page load: the correlation id of the lines that belong to no turn. */
export const PAGE_ID: string = crypto.randomUUID();

export const log: Log = createLogger(
  'alexa-sim',
  (entry) => {
    for (const sink of sinks) sink(entry);
  },
  { pageId: PAGE_ID },
);

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

/**
 * A voice failure (#25): its code and phase, the turn when there is one; never what was said. An info line: the
 * person hears about it and the UI handles it (no speech, a denied microphone); nothing for the server log.
 */
export function voiceFailureEvent({ code, phase, turnId }: VoiceFailure): LogEvent {
  return { level: 'info', code, ...(turnId !== null && { correlationId: turnId }), details: { phase } };
}
