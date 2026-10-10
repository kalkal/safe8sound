import { categoryOf, type HomeId, type HomeProfile } from '@cold-reserve/contracts';
import { epsBaseLoadW } from '@cold-reserve/core';
import type { SourceEvent } from '@cold-reserve/source-fallback';
import type { ServerConfig } from './config.js';
import type { Logger } from './handler.js';

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
