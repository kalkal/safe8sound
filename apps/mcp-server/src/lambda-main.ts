import { err, ok, toolError } from '@cold-reserve/contracts';
import { jsonLineSink, loggerTo } from '@cold-reserve/core';
import { createApp } from './app.js';
import { comfortPlanWiring } from './comfort-plan-config.js';
import { composeModules, createDynamoStoreFactory } from './compose.js';
import { createLambdaHandler, installProcessHooks, storeErrorLogger, toLogEntry, type LambdaLogEntry, metricsTo } from './lambda.js';
import { loadPreferencesConfig, preferencesConfigFile } from './preferences-config.js';
import { readParameter } from './ssm.js';
import { stormModeWiring } from './storm-mode-config.js';

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
    const clients = await readParameter(parameter, { fetchFn: fetch, sessionToken, timeoutMs: Number(process.env['SSM_TIMEOUT_MS'] ?? 2000) });
    if (!clients.ok) return clients;

    const wallClock = { now: Date.now };
    const preferences = loadPreferencesConfig(preferencesConfigFile());
    if (!preferences.ok) return preferences;
    const storeFor = createDynamoStoreFactory(process.env, {
      clock: wallClock,
      onError: storeErrorLogger(log),
    });
    if (!storeFor.ok) return storeFor;
    const modules = composeModules({ preferences: preferences.value, storeFor: storeFor.value, clock: wallClock });
    if (!modules.ok) return modules;
    const comfortPlan = comfortPlanWiring({ storeFor: storeFor.value, preferences: preferences.value, clock: wallClock });
    if (!comfortPlan.ok) return comfortPlan;

    // The family phone's inbox lives in the same table (#24); its HTTP route is not served here.
    const stormMode = stormModeWiring({ storeFor: storeFor.value, preferences: preferences.value, clock: wallClock });
    if (!stormMode.ok) return stormMode;

    // No cardDocuments yet: the built card bundle is not shipped with the function, so the Lambda serves
    // the tools without their ui:// cards. TODO(#104): ship the card bundle with the MCP Lambda.
    const app = createApp(
      { ...process.env, MCP_CLIENTS: clients.value },
      {
        wallClock,
        logger,
        metrics: metricsTo((text) => {
          process.stdout.write(text);
        }),
        modules: modules.value,
        comfortPlan: comfortPlan.value,
        stormMode: stormMode.value,
      },
    );
    return app.ok ? ok(app.value.handler) : app;
  },
  { log },
);
