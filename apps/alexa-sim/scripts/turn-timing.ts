import { z } from 'zod';

// The browser's waits in the AWS build (#270): from the one timing table of a turn in infra/cdk.json
// (`cold-reserve:turnTiming`), so they can never fall below sim-api's wait for the agent. Read as data by the
// build, never imported as a module: the simulator does not depend on the infra package.

const CdkSchema = z.object({
  context: z.object({
    'cold-reserve:turnTiming': z.object({
      browserTimeoutMs: z.number().int().positive(),
      turnBudgetMs: z.number().int().positive(),
    }),
  }),
});

/** The site build's env from cdk.json; throws when the table is missing, so a build never ships a guess. */
export function siteTimingEnv(cdk: unknown): { VITE_AGENT_TIMEOUT_MS: string; VITE_TURN_BUDGET_MS: string } {
  const parsed = CdkSchema.safeParse(cdk);
  if (!parsed.success) throw new Error('infra/cdk.json has no valid cold-reserve:turnTiming table.');
  const t = parsed.data.context['cold-reserve:turnTiming'];
  return { VITE_AGENT_TIMEOUT_MS: String(t.browserTimeoutMs), VITE_TURN_BUDGET_MS: String(t.turnBudgetMs) };
}
