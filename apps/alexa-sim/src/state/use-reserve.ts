import type { ReserveOutlook, ScenarioId } from '@cold-reserve/contracts';
import { useEffect, useState } from 'react';
import type { Agent } from '../agent/agent.js';
import { fetchReserve } from '../ui/reserve.js';

/**
 * The cold reserve of the idle screen (owner, 11 Oct): read when `enabled`, again when the scenario, the grid or the
 * simulated time changes, never polled. A new reading drops the old hours first (never a calm day's hours beside a
 * melting cube), and a reply that comes after the next change is dropped; a failed read leaves none, quietly
 * (fetchReserve logs it).
 */
export function useReserve(o: { agent: Agent; enabled: boolean; scenarioId: ScenarioId | undefined; gridDown: boolean; now: string | undefined }): ReserveOutlook | undefined {
  const { agent, enabled, scenarioId, gridDown, now } = o;
  const [reserve, setReserve] = useState<ReserveOutlook | undefined>(undefined);
  useEffect(() => {
    setReserve(undefined);
    if (!enabled) return undefined;
    let current = true;
    void fetchReserve(agent, { correlationId: crypto.randomUUID() }).then((read) => {
      if (current && read.ok) setReserve(read.value);
    });
    return () => {
      current = false;
    };
  }, [agent, enabled, scenarioId, gridDown, now]);
  return reserve;
}
