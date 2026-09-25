import { z } from 'zod';
import { err, ok } from '../result.js';
import { defineTool } from '../tool.js';
import { toolError } from '../tool-error.js';

export interface HomeSnapshot {
  stateOfChargePct: number;
  reserveHours: number;
  observedAt: number;
}

export interface ReserveStatusDeps {
  getSnapshot: (homeId: string) => HomeSnapshot | undefined;
  now: () => number;
  staleAfterMs: number;
}

const RETRY_STALE_AFTER_MS = 60_000;

export function reserveStatusTool(deps: ReserveStatusDeps) {
  return defineTool({
    name: 'get_reserve_status',
    description: 'Current battery state of charge and how many hours of comfort reserve it covers.',
    input: z.object({
      homeId: z.string().min(1).max(64).describe('Home identifier, e.g. "home-demo".'),
    }),
    output: z.object({
      homeId: z.string(),
      stateOfChargePct: z.number().min(0).max(100),
      reserveHours: z.number().nonnegative(),
      dataOrigin: z.enum(['real', 'simulated']),
      ageSeconds: z.number().int().nonnegative(),
    }),
    summarize: (o) =>
      `Battery at ${o.stateOfChargePct}%, about ${o.reserveHours} hours of reserve (${o.dataOrigin} data, ${o.ageSeconds}s old).`,
    handler: async ({ homeId }) => {
      const snapshot = deps.getSnapshot(homeId);
      if (!snapshot) {
        return err(toolError('home_not_found', 'not_found', `No home with id "${homeId}". Check the home id and try again.`));
      }
      const ageMs = Math.max(0, deps.now() - snapshot.observedAt);
      const ageSeconds = Math.round(ageMs / 1000);
      if (ageMs > deps.staleAfterMs) {
        return err(
          toolError('home_data_stale', 'dependency_unavailable', `The latest home reading is ${Math.round(ageSeconds / 60)} minutes old.`, {
            retryAfterMs: RETRY_STALE_AFTER_MS,
            details: { ageSeconds },
          }),
        );
      }
      return ok({
        homeId,
        stateOfChargePct: snapshot.stateOfChargePct,
        reserveHours: snapshot.reserveHours,
        dataOrigin: 'simulated' as const,
        ageSeconds,
      });
    },
  });
}
