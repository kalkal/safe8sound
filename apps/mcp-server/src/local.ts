import { createApp } from './app.js';
import { startNodeServer } from './node-server.js';

// Local Node entry: 127.0.0.1 only (plan §13.2.3). Tokens from MCP_CLIENTS in the environment.
const log = (line: object) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), component: 'mcp-server', ...line }));
};

const app = createApp(process.env, { logger: { log } });
if (!app.ok) {
  log({ level: 'error', code: app.error.code, message: app.error.message });
  process.exit(1);
}

const server = await startNodeServer(app.value.handler, { host: '127.0.0.1', port: Number(process.env['PORT'] ?? 3316), path: app.value.config.path, maxBodyBytes: app.value.config.maxBodyBytes });
console.log(JSON.stringify({ level: 'info', component: 'mcp-server', message: `listening on ${server.url}` }));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
