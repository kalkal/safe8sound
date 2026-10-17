import { err, ok, toolError } from '@cold-reserve/contracts';
import { jsonLineSink, loggerTo } from '@cold-reserve/core';
import { extensionReader } from '@cold-reserve/ssm-parameters';
import { createDynamoStoreFactory } from './compose.js';
import { createLambdaHandler, installProcessHooks, storeErrorLogger, toLogEntry, type LambdaLogEntry, metricsTo } from './lambda.js';
import { createLambdaApp } from './lambda-app.js';

// Lambda entry: the client tokens come from SSM (SecureString) named by MCP_CLIENTS_PARAMETER;
// state lives in the single DynamoDB table named by STATE_TABLE_NAME.
// One sink for every line: one JSON object per line on stdout, so the InternalErrors metric filter
// finds `category` at the top level (reviews of #134 and #139).
const logger = loggerTo(
  jsonLineSink((text) => {
    process.stdout.write(text);
  }),
);
const log = (entry: LambdaLogEntry) => {
  logger.log(toLogEntry(entry));
};

installProcessHooks(process, {
  log,
  exit: (code) => {
    process.exit(code);
  },
});

export const handler = createLambdaHandler(
  async () => {
    const parameter = process.env['MCP_CLIENTS_PARAMETER'];
    const sessionToken = process.env['AWS_SESSION_TOKEN'];
    if (!parameter || !sessionToken) return err(toolError('invalid_config', 'MCP_CLIENTS_PARAMETER or AWS_SESSION_TOKEN is not set.'));
    const clients = await extensionReader({ fetchFn: fetch, sessionToken, timeoutMs: process.env['SSM_TIMEOUT_MS'] })(parameter);
    if (!clients.ok) return clients;

    const wallClock = { now: Date.now };
    // A local-only lever (#160): never on Lambda, where it is ignored and said once at start-up.
    if (process.env['MCP_SCENARIO_START_SOC_PCT'] !== undefined) {
      logger.log({ ts: new Date().toISOString(), level: 'info', component: 'mcp-server', message: 'MCP_SCENARIO_START_SOC_PCT is for the local entry only: ignored here.', correlationId: 'startup' });
    }
    // The store keeps the wall clock (its TTL); the domain runs on the scenario clock inside createLambdaApp (#175).
    const storeFor = createDynamoStoreFactory(process.env, {
      clock: wallClock,
      onError: storeErrorLogger(log),
    });
    if (!storeFor.ok) return storeFor;
    const app = createLambdaApp(
      { ...process.env, MCP_CLIENTS: clients.value },
      {
        wallClock,
        logger,
        storeFor: storeFor.value,
        metrics: metricsTo((text) => {
          process.stdout.write(text);
        }),
      },
    );
    return app.ok ? ok(app.value.handler) : app;
  },
  {
    log,
    // The warm-up's line (#407) goes through the same sink as every other line.
    info: (entry) => {
      logger.log(entry);
    },
  },
);
