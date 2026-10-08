import type { ErrorEnvelope, Result } from '@cold-reserve/contracts';
import { cardDocumentsFromFiles, workspaceCardFiles } from './cards.js';
import { forLocalEntry } from './config.js';
import { createLocalApp, localStartSocPct } from './local-app.js';
import { startNodeServer } from './node-server.js';
import { createLocalHandler, createPhoneInboxHandler } from './phone-inbox.js';

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
const local = orExit(createLocalApp(process.env, { wallClock, logger: { log }, cardDocuments: cardDocumentsFromFiles(workspaceCardFiles()) }));
const { app, stormMode } = local;
// The validated value: an empty MCP_SCENARIO_START_SOC_PCT means the lever is off.
const startSoc = orExit(localStartSocPct(process.env));
if (startSoc !== undefined) log({ level: 'info', message: `Local lever: the scenario starts with the battery at ${String(startSoc)}%.`, correlationId: 'startup' });
// MCP_RESOURCE_URL=auto is for Lambda only (#149): locally the canonical URL has no trustworthy source.
orExit(forLocalEntry(app.config));

// The family phone's inbox (#24); a sandbox phone token (held by sim-api) reads the visitor sandboxes (#267).
const phone = createPhoneInboxHandler(app.config, { inbox: stormMode.inbox, admit: app.admitSandbox, ...(app.familyReply === undefined ? {} : { reply: app.familyReply }), logger: { log } });
const server = await startNodeServer(createLocalHandler(app.handler, phone), { host: '127.0.0.1', port: Number(process.env['PORT'] ?? 3316), path: app.config.path, maxBodyBytes: app.config.maxBodyBytes });
console.log(JSON.stringify({ level: 'info', component: 'mcp-server', message: `listening on ${server.url}` }));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
