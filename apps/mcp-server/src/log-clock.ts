import type { Clock, Logger } from '@cold-reserve/core';

/**
 * CE-20: the domain runs on the scenario clock, but log lines line up with the sim-api's and the agent's on the
 * wall clock. Each line's `ts` becomes the wall time; the domain's own time, when it differs, moves to
 * `details.scenarioTs`. Best effort, like every logger: a sink that throws never breaks the caller.
 */
export function wallStamped(logger: Logger, wallClock: Clock): Logger {
  return {
    log: (entry) => {
      try {
        const ts = new Date(wallClock.now()).toISOString();
        // Under a second apart is the same time (a domain on the wall clock stamps its own millisecond).
        const sameTime = Math.abs(Date.parse(entry.ts) - Date.parse(ts)) < 1000;
        logger.log(sameTime ? { ...entry, ts } : { ...entry, ts, details: { ...entry.details, scenarioTs: entry.ts } });
      } catch {
        // Nowhere left to report it: the line is lost, the request goes on.
      }
    },
  };
}
