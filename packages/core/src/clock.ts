/** Time source in epoch milliseconds, injected so core never calls Date.now(). */
export interface Clock {
  now(): number;
  /** A scenario clock only: the wall instant the current playthrough of its scenario began (#234). */
  readonly playthrough?: () => number;
}

export const fixedClock = (ms: number): Clock => ({ now: () => ms });

const DAY_MS = 86_400_000;

/** The start of the UTC day of an instant: a daily anchor that every container computes alike. */
export const utcDayStart = (ms: number): number => ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS);

/**
 * Scenario time (plan §9.4: the simulator runs on scenario time, not on the time of day):
 * the wall-clock instant `anchorMs` maps to `scenarioStartMs`, and time then runs `speed` times faster.
 * `anchorMs` may be a function of the wall time (e.g. `utcDayStart`, so the scenario replays every day).
 */
export function scenarioClock(opts: { wall: Clock; anchorMs: number | ((wallMs: number) => number); scenarioStartMs: number; speed?: number }): Clock {
  const speed = opts.speed ?? 1;
  const anchor = opts.anchorMs;
  const anchorAt = (wall: number) => (typeof anchor === 'number' ? anchor : anchor(wall));
  return {
    now: () => {
      const wall = opts.wall.now();
      return opts.scenarioStartMs + (wall - anchorAt(wall)) * speed;
    },
    // The anchor is where the scenario starts again: with a daily anchor a new playthrough every day.
    playthrough: () => anchorAt(opts.wall.now()),
  };
}
