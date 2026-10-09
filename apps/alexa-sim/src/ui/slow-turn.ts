import { useEffect, useState } from 'react';

/**
 * After this long in one turn the waiting screen says it is still working (#270), whatever makes it slow: a cold
 * AgentCore start can take most of the 16 s browser wait, and a silent wait that long looks broken.
 */
export const SLOW_TURN_NOTICE_MS = 8000;

/** True once a turn has been waiting for SLOW_TURN_NOTICE_MS; false again as soon as it stops waiting. */
export function useSlowTurn(waiting: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!waiting) {
      setSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      setSlow(true);
    }, SLOW_TURN_NOTICE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [waiting]);
  return waiting && slow;
}
