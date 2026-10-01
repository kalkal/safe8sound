import type { HomeId } from '@cold-reserve/contracts';
import type { HomeAgent } from './invocations.js';

/**
 * One agent per sandbox home (its own history), at most `max` in memory: the least recently used
 * goes first. On AgentCore each session gets its own microVM; this is the local equivalent.
 */
export function homeAgents(opts: { max: number; create: (home: HomeId) => HomeAgent }): (home: HomeId) => HomeAgent {
  const agents = new Map<HomeId, HomeAgent>();
  return (home) => {
    const existing = agents.get(home);
    if (existing) {
      agents.delete(home); // re-insert: Map order is the recency order
      agents.set(home, existing);
      return existing;
    }
    const created = opts.create(home);
    agents.set(home, created);
    if (agents.size > opts.max) {
      const oldest = agents.keys().next().value;
      if (oldest !== undefined) agents.delete(oldest);
    }
    return created;
  };
}
