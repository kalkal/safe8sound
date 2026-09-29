/** Time source in epoch milliseconds, injected so core never calls Date.now(). */
export interface Clock {
  now(): number;
}

export const fixedClock = (ms: number): Clock => ({ now: () => ms });

/**
 * Scenario time (plan §9.4: the simulator runs on scenario time, not on the time of day):
 * the wall-clock instant `anchorMs` maps to `scenarioStartMs`, and time then runs `speed` times faster.
 */
export function scenarioClock(opts: { wall: Clock; anchorMs: number; scenarioStartMs: number; speed?: number }): Clock {
  const speed = opts.speed ?? 1;
  return { now: () => opts.scenarioStartMs + (opts.wall.now() - opts.anchorMs) * speed };
}
