import { ok, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { loadConfig, type ServerConfig } from './config.js';
import { createMcpHandler, type Logger, type McpHandler } from './handler.js';
import { createRegistry, type CapabilityModule, type ModuleRegistry } from './registry.js';

export interface AppOptions {
  readonly logger: Logger;
  /** The capability modules to serve; energy-status is the first (issue #16, part 2). */
  readonly modules?: readonly CapabilityModule[];
}

export interface App {
  readonly config: ServerConfig;
  readonly registry: ModuleRegistry;
  readonly handler: McpHandler;
}

/**
 * Composition root shared by the local Node entry and the Lambda entry (plan §9.2: dependencies
 * built by a factory, no DI framework).
 */
export function createApp(env: Readonly<Record<string, string | undefined>>, opts: AppOptions): Result<App, ErrorEnvelope> {
  const config = loadConfig(env);
  if (!config.ok) return config;
  const registry = createRegistry(opts.modules ?? []);
  if (!registry.ok) return registry;
  return ok({
    config: config.value,
    registry: registry.value,
    handler: createMcpHandler(config.value, { registry: registry.value, logger: opts.logger }),
  });
}
