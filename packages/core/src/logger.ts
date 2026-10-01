import type { LogEntry } from '@cold-reserve/contracts';

// The logger port (audit L1, #111): every component writes the shared LogEntry line through it. Adapters
// decide where lines go (stdout JSON on Lambda, a JSON Lines file locally, the browser console).

export interface Logger {
  log(entry: LogEntry): void;
}

const STACK_MAX = 4000;

/**
 * What a log line may say about a cause: its name, and its stack on the server. Never the cause's text: a
 * message can carry user input or a secret.
 */
export function causeFields(cause: unknown, opts: { withStack: boolean }): { errorName: string; stack?: string } {
  if (!(cause instanceof Error)) return { errorName: cause === null ? 'null' : typeof cause };
  const errorName = (cause.name || cause.constructor.name || 'Error').slice(0, 80);
  if (!opts.withStack || cause.stack === undefined) return { errorName };
  // The stack starts with "Name: message", and the message may span lines: keep only the frames, under the name.
  const frames = cause.stack.indexOf('\n    at ');
  const stack = frames < 0 ? errorName : `${errorName}${cause.stack.slice(frames)}`;
  return { errorName, stack: stack.slice(0, STACK_MAX) };
}

/** Where lines go: injected by the adapter (stdout on Lambda and Node, the console in a browser). */
export type LogSink = (entry: LogEntry) => void;

/** A logger over any sink. Logging is best effort: a sink that throws never breaks the caller. */
export function loggerTo(sink: LogSink): Logger {
  return {
    log: (entry) => {
      try {
        sink(entry);
      } catch {
        // Nowhere left to report it: the line is lost, the request goes on.
      }
    },
  };
}

/**
 * A sink writing one JSON object per line with `write` (for example `process.stdout.write`): on Lambda the
 * fields stay at the top level, where a CloudWatch metric filter on `$.category` finds them.
 */
export function jsonLineSink(write: (text: string) => void): LogSink {
  return (entry) => {
    write(`${JSON.stringify(entry)}\n`);
  };
}

/** A logger that keeps its lines: for tests and fault injection. */
export function memoryLogger(): Logger & { readonly lines: LogEntry[] } {
  const lines: LogEntry[] = [];
  return { lines, log: (entry) => lines.push(entry) };
}
