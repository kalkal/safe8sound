import { HomeProfileSchema, categoryOf, err, isDemoHomeId, ok, toolError, type ErrorEnvelope, type HomeId, type HomeProfile, type Result } from '@cold-reserve/contracts';
import { epsBaseLoadW } from '@cold-reserve/core';
import type { SourceEvent } from '@cold-reserve/source-fallback';
import type { ServerConfig } from './config.js';
import type { Logger } from './handler.js';
import { isSandbox } from './sandbox-log.js';

// What the server says at start-up and when the real home's link changes (out of app.ts, #319).

/**
 * Off grid the simulator, the guard and the storm safe hours read the EPS load from the home profile. A profile
 * without it gets no assumed figure: its storm calculations refuse (`missing_eps_load`), and start-up says so.
 */
export function warnMissingEpsLoad(profiles: readonly HomeProfile[], logger: Logger): void {
  for (const profile of profiles) {
    const eps = epsBaseLoadW(profile);
    if (eps.ok) continue;
    logger.log({
      ts: new Date().toISOString(),
      level: 'warn',
      component: 'mcp-server',
      code: 'missing_eps_load',
      category: 'internal',
      message: 'The home profile gives no epsBaseLoadW: a simulated home gives no readings, and storm calculations refuse, until it does.',
      correlationId: 'startup',
      homeId: profile.homeId,
    });
  }
}

/**
 * The real home's data source switching to the simulator and back, in the shared log (#113). Not tied to one
 * request (the source is read by many), so the correlation id names the link.
 */
export function logSourceEvent(logger: Logger, homeId: HomeId): (event: SourceEvent) => void {
  return (event) => {
    const base = { ts: event.at, component: 'mcp-server', correlationId: 'home-link', homeId, details: { event: event.type } } as const;
    if (event.type === 'HOME_REACHABLE') {
      logger.log({ ...base, level: 'info', message: 'The home answers again: live data is back.' });
    } else if (event.type === 'HOME_UNREACHABLE') {
      logger.log({
        ...base,
        level: 'warn',
        code: event.reason,
        category: categoryOf(event.reason),
        message: `The home's data is ${event.homeLink}: the simulator stands in, and every reply says so.`,
        ...(event.errorName === undefined ? {} : { errorName: event.errorName }),
        details: { event: event.type, homeLink: event.homeLink, ...(event.lastLiveAt === undefined ? {} : { lastLiveAt: event.lastLiveAt }) },
      });
    } else {
      logger.log({
        ...base,
        level: 'error',
        code: event.code,
        category: categoryOf(event.code),
        message: 'The simulator standing in for the home failed: no home data until it is fixed.',
        ...(event.errorName === undefined ? {} : { errorName: event.errorName }),
      });
    }
  };
}

/**
 * The client scopes at start-up (#233): how many grants are agent, cards, phone or unscoped, counts only. After a
 * deploy it shows whether the agent:/cards: prefixes in the SSM client list took.
 */
export function logClientScopes(config: ServerConfig, logger: Logger): void {
  const counts = { agent: 0, cards: 0, phone: 0, unscoped: 0 };
  for (const grant of config.clients.values()) counts[grant.scope ?? 'unscoped'] += 1;
  logger.log({
    ts: new Date().toISOString(),
    level: 'info',
    component: 'mcp-server',
    message: `Client scopes: ${String(counts.agent)} agent, ${String(counts.cards)} cards, ${String(counts.phone)} phone, ${String(counts.unscoped)} unscoped.`,
    correlationId: 'startup',
    details: { event: 'client_scopes', ...counts },
  });
}

/** The Protected Resource Metadata mode at start-up (#149): auto, fixed or off, never the URL itself. */
export function logMetadataMode(config: ServerConfig, logger: Logger): void {
  const pr = config.protectedResource;
  const mode = pr === undefined ? 'off' : pr.resource === 'auto' ? 'auto' : 'fixed';
  logger.log({
    ts: new Date().toISOString(),
    level: 'info',
    component: 'mcp-server',
    message: `Protected resource metadata: ${mode}.`,
    correlationId: 'startup',
    details: { event: 'protected_resource_metadata', mode, authorizationServers: pr?.authorizationServers.length ?? 0 },
  });
}

/**
 * A home profile as a value (R17): the real home with the demo's fictional names, or any other invalid profile, is
 * refused with `invalid_config` and one error line naming the fields, never their values nor a sandbox's id.
 */
export function homeProfileOf(raw: unknown, logger: Logger, correlationId: string): Result<HomeProfile, ErrorEnvelope> {
  const parsed = HomeProfileSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  const homeId = typeof raw === 'object' && raw !== null && 'homeId' in raw && typeof raw.homeId === 'string' ? raw.homeId : '';
  const home = isSandbox(homeId) ? 'sandbox' : isDemoHomeId(homeId) ? 'demo' : 'real';
  const fields = [...new Set(parsed.error.issues.map((i) => i.path.map(String).join('.')))];
  logger.log({
    ts: new Date().toISOString(),
    level: 'error',
    component: 'mcp-server',
    code: 'invalid_config',
    category: categoryOf('invalid_config'),
    message: 'A home profile was refused: names belong only to a demo or sandbox home, and every field must be valid.',
    correlationId,
    details: { event: 'home_profile_refused', home, fields },
  });
  return err(toolError('invalid_config', 'The home profile is not valid.'));
}
