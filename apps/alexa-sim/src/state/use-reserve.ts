import type { ErrorEnvelope, ReserveOutlook, Result, SafeRoomStatus, ScenarioId } from '@cold-reserve/contracts';
import { useEffect, useState } from 'react';
import type { Agent, AskContext } from '../agent/agent.js';
import { fetchReserve, fetchSafeRoom } from '../ui/reserve.js';

interface IdleReadingInput {
  agent: Agent;
  enabled: boolean;
  scenarioId: ScenarioId | undefined;
  gridDown: boolean;
  /** The simulated time: each move of the clock reads again (one reading per jump, never polled). */
  now: string | undefined;
  /** A count that reads again when it moves: a plan applied, by a tap or by voice (owner, 21 Oct: "Plan active"). */
  again?: number;
}

/**
 * One reading of the idle screen: read when `enabled`, again when the scenario, the grid, the simulated time or
 * `again` changes, never polled. A new reading drops the old value first (never a calm day's hours beside a melting cube), and
 * a reply that comes after the next change is dropped; a failed read leaves none, quietly (the fetch logs it). `read`
 * is a module function, the same at every render.
 */
function useIdleReading<T>(read: (agent: Agent, context: AskContext) => Promise<Result<T, ErrorEnvelope>>, o: IdleReadingInput): T | undefined {
  const { agent, enabled, scenarioId, gridDown, now, again } = o;
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    setValue(undefined);
    if (!enabled) return undefined;
    let current = true;
    void read(agent, { correlationId: crypto.randomUUID() }).then((result) => {
      if (current && result.ok) setValue(result.value);
    });
    return () => {
      current = false;
    };
  }, [read, agent, enabled, scenarioId, gridDown, now, again]);
  return value;
}

/** The cold reserve of the idle screen (owner, 11 Oct): its hours and ice cubes. */
export function useReserve(o: IdleReadingInput): ReserveOutlook | undefined {
  return useIdleReading(fetchReserve, o);
}

/** Leo's room on the idle screen (#432 S6, owner D2 = b): the time it stays safe until, read again at every jump. */
export function useSafeRoom(o: IdleReadingInput): SafeRoomStatus | undefined {
  return useIdleReading(fetchSafeRoom, o);
}
