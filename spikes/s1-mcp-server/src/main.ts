import { loadConfig } from './config.js';
import { createMcpHandler } from './handler.js';
import { startNodeServer } from './node-server.js';
import { reserveStatusTool, type HomeSnapshot } from './tools/reserve-status.js';

const config = loadConfig(process.env);
if (!config.ok) {
  console.error(JSON.stringify({ level: 'error', component: 'mcp-server', code: config.error.code, message: config.error.message }));
  process.exit(1);
}

// Fixed demo data: the spike never touches the real home.
const started = Date.now();
const snapshots: Record<string, HomeSnapshot> = {
  'home-demo': { stateOfChargePct: 62, reserveHours: 9.5, observedAt: started },
  'home-stale': { stateOfChargePct: 40, reserveHours: 5, observedAt: started - 20 * 60_000 },
};

const handler = createMcpHandler(config.value, {
  tools: [
    reserveStatusTool({
      getSnapshot: (id) => (id === 'home-demo' ? { ...snapshots[id]!, observedAt: Date.now() - 30_000 } : snapshots[id]),
      now: Date.now,
      staleAfterMs: Number(process.env.HOME_DATA_STALE_AFTER_MS ?? 15 * 60_000),
    }),
  ],
  logger: { log: (entry) => console.error(JSON.stringify(entry)) },
});

const server = await startNodeServer(handler, {
  host: process.env.MCP_HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
});
console.log(JSON.stringify({ level: 'info', component: 'mcp-server', message: `listening on ${server.url}` }));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void server.close().then(() => process.exit(0)));
}
