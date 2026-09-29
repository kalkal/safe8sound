import type { ErrorEnvelope, Result, Snapshot } from '@cold-reserve/contracts';

/**
 * The one data-source port (plan §1 principle 3): the real home, the simulator, a scenario,
 * or a fallback that composes them. Expected failures come back as values.
 */
export interface HomeDataSource {
  snapshot(): Promise<Result<Snapshot, ErrorEnvelope>>;
}
