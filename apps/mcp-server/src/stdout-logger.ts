import { jsonLineSink, loggerTo, type Logger } from '@cold-reserve/core';

/** The Node entry's sink (#143): the shared LogEntry, one JSON line on stdout, like the Lambda entry. */
export function stdoutLogger(): Logger {
  return loggerTo(
    jsonLineSink((text) => {
      process.stdout.write(text);
    }),
  );
}
