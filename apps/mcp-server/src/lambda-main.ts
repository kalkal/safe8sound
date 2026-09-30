import { err, ok, toolError } from '@cold-reserve/contracts';
import { createApp } from './app.js';
import { comfortPlanWiring } from './comfort-plan-config.js';
import { composeModules, createDynamoStoreFactory } from './compose.js';
import { createLambdaHandler } from './lambda.js';
import { loadPreferencesConfig, preferencesConfigFile } from './preferences-config.js';
import { readParameter } from './ssm.js';

// Lambda entry: the client tokens come from SSM (SecureString) named by MCP_CLIENTS_PARAMETER;
// state lives in the single DynamoDB table named by STATE_TABLE_NAME.
const log = (entry: object) => {
  console.error(JSON.stringify(entry));
};

export const handler = createLambdaHandler(async () => {
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
    onError: (event) => {
      log({ level: 'error', component: 'store-dynamodb', code: event.code, operation: event.operation, cause: String(event.cause) });
    },
  });
  if (!storeFor.ok) return storeFor;
  const modules = composeModules({ preferences: preferences.value, storeFor: storeFor.value, clock: wallClock });
  if (!modules.ok) return modules;
  const comfortPlan = comfortPlanWiring({ storeFor: storeFor.value, preferences: preferences.value, clock: wallClock });
  if (!comfortPlan.ok) return comfortPlan;

  const app = createApp({ ...process.env, MCP_CLIENTS: clients.value }, { wallClock, logger: { log }, modules: modules.value, comfortPlan: comfortPlan.value });
  return app.ok ? ok(app.value.handler) : app;
});
