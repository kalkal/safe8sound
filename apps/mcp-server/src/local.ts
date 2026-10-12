import type { ErrorEnvelope, Result } from '@cold-reserve/contracts';
import { cardDocumentsFromFiles, workspaceCardFiles } from './cards.js';
import { forLocalEntry } from './config.js';
import { createLocalApp, localStartSocPct } from './local-app.js';
import { startNodeServer } from './node-server.js';
import { createLocalHandler, createPhoneInboxHandler } from './phone-inbox.js';
import { stdoutLogger } from './stdout-logger.js';

// Local Node entry: 127.0.0.1 only (plan §13.2.3). Tokens from MCP_CLIENTS in the environment.
// State lives in memory: it survives new MCP sessions, not a restart of this process.
// Every line is the shared LogEntry, one JSON line on stdout (#143); start-up lines carry the correlation id 'startup'.
const logger = stdoutLogger();
// The message comes last: the e2e and conformance runs read the URL up to the closing quote of `listening on ...`.
const startupLine = (message: string) => ({ ts: new Date().toISOString(), level: 'info' as const, component: 'mcp-server', correlationId: 'startup', message });

/** A configuration error stops the process at startup, with the reason in the log (never a token: the message names the setting). */
function orExit<T>(result: Result<T, ErrorEnvelope>): T {
  if (result.ok) return result.value;
  const { code, category, message, details } = result.error;
  logger.log({ ...startupLine(message), level: 'error', code, category, ...(details === undefined ? {} : { details }) });
  process.exit(1);
}

const wallClock = { now: Date.now };
const local = orExit(createLocalApp(process.env, { wallClock, logger, cardDocuments: cardDocumentsFromFiles(workspaceCardFiles()) }));
const { app, stormMode } = local;
// The validated value: an empty MCP_SCENARIO_START_SOC_PCT means the lever is off.
const startSoc = orExit(localStartSocPct(process.env));
if (startSoc !== undefined) logger.log(startupLine(`Local lever: the scenario starts with the battery at ${String(startSoc)}%.`));
// MCP_RESOURCE_URL=auto is for Lambda only (#149): locally the canonical URL has no trustworthy source.
orExit(forLocalEntry(app.config));

// The family phone's inbox (#24); a sandbox phone token (held by sim-api) reads the visitor sandboxes (#267).
const phone = createPhoneInboxHandler(app.config, { inbox: stormMode.inbox, admit: app.admitSandbox, ...(app.familyReply === undefined ? {} : { reply: app.familyReply }), logger });
const server = await startNodeServer(createLocalHandler(app.handler, phone), { host: '127.0.0.1', port: Number(process.env['PORT'] ?? 3316), path: app.config.path, maxBodyBytes: app.config.maxBodyBytes, logger });
logger.log(startupLine(`listening on ${server.url}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
