import type { ErrorEnvelope, Result } from '@cold-reserve/contracts';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { createApp } from './app.js';
import { comfortPlanWiring } from './comfort-plan-config.js';
import { composeModules } from './compose.js';
import { startNodeServer } from './node-server.js';
import { loadPreferencesConfig, preferencesConfigFile } from './preferences-config.js';

// Local Node entry: 127.0.0.1 only (plan §13.2.3). Tokens from MCP_CLIENTS in the environment.
// State lives in memory: it survives new MCP sessions, not a restart of this process.
const log = (line: object) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), component: 'mcp-server', ...line }));
};

/** A configuration error stops the process at startup, with the reason in the log. */
function orExit<T>(result: Result<T, ErrorEnvelope>): T {
  if (result.ok) return result.value;
  log({ level: 'error', code: result.error.code, message: result.error.message, details: result.error.details });
  process.exit(1);
}

const wallClock = { now: Date.now };
const preferences = orExit(loadPreferencesConfig(preferencesConfigFile()));
const storeFor = memoryStateStoreFactory({ backing: createMemoryBacking(), clock: wallClock });
const modules = orExit(composeModules({ preferences, storeFor, clock: wallClock }));
const comfortPlan = orExit(comfortPlanWiring({ storeFor, preferences, clock: wallClock }));
const app = orExit(createApp(process.env, { wallClock, logger: { log }, modules, comfortPlan }));

const server = await startNodeServer(app.handler, { host: '127.0.0.1', port: Number(process.env['PORT'] ?? 3316), path: app.config.path, maxBodyBytes: app.config.maxBodyBytes });
console.log(JSON.stringify({ level: 'info', component: 'mcp-server', message: `listening on ${server.url}` }));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
