import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';

// Every threshold comes from config (Vite env), never from the components.

const DEFAULT_HOME_TIME_ZONE = 'Europe/Rome';

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const ConfigSchema = z
  .strictObject({
    agent: z.enum(['scripted', 'remote']),
    simApiUrl: z.string().min(1).optional(),
    agentTimeoutMs: z.coerce.number().int().positive(),
    turnBudgetMs: z.coerce.number().int().positive(),
    /** IANA zone of the home: every time on screen is on the home's clock (sim-api will provide it per home). */
    homeTimeZone: z.string().refine(isTimeZone, { message: 'Unknown IANA time zone' }),
  })
  .refine((c) => c.agent === 'scripted' || c.simApiUrl !== undefined, { path: ['simApiUrl'], message: 'The remote agent needs a sim-api URL' })
  .refine((c) => c.turnBudgetMs >= c.agentTimeoutMs, { path: ['turnBudgetMs'], message: 'The turn budget must cover the agent timeout' });
export type SimConfig = z.infer<typeof ConfigSchema>;

/** Same-origin path the fault-injection E2E tests intercept. */
const DEV_SIM_API_PATH = '/sim-api';

export function parseConfig(env: Readonly<Record<string, string | undefined>>, search: string, isDev: boolean): Result<SimConfig, ErrorEnvelope> {
  const override = isDev ? new URLSearchParams(search).get('agent') : null;
  const agent = override ?? env['VITE_AGENT'] ?? 'scripted';
  const parsed = ConfigSchema.safeParse({
    agent,
    simApiUrl: env['VITE_SIM_API_URL'] ?? (override === 'remote' ? DEV_SIM_API_PATH : undefined),
    agentTimeoutMs: env['VITE_AGENT_TIMEOUT_MS'] ?? 8_000,
    turnBudgetMs: env['VITE_TURN_BUDGET_MS'] ?? 10_000,
    homeTimeZone: env['VITE_HOME_TIME_ZONE'] ?? DEFAULT_HOME_TIME_ZONE,
  });
  if (parsed.success) return ok(parsed.data);
  const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message.slice(0, 200) }));
  return err(toolError('invalid_config', 'The simulator configuration is invalid.', { details: { issues } }));
}
