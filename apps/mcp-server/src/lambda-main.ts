import { err, ok, toolError } from '@cold-reserve/contracts';
import { createApp } from './app.js';
import { createLambdaHandler } from './lambda.js';
import { readParameter } from './ssm.js';

// Lambda entry: the client tokens come from SSM (SecureString) named by MCP_CLIENTS_PARAMETER.
export const handler = createLambdaHandler(async () => {
  const parameter = process.env['MCP_CLIENTS_PARAMETER'];
  const sessionToken = process.env['AWS_SESSION_TOKEN'];
  if (!parameter || !sessionToken) return err(toolError('invalid_config', 'MCP_CLIENTS_PARAMETER or AWS_SESSION_TOKEN is not set.'));
  const clients = await readParameter(parameter, { fetchFn: fetch, sessionToken, timeoutMs: Number(process.env['SSM_TIMEOUT_MS'] ?? 2000) });
  if (!clients.ok) return clients;
  const app = createApp(
    { ...process.env, MCP_CLIENTS: clients.value },
    {
      wallClock: { now: Date.now },
      logger: {
        log: (entry) => {
          console.error(JSON.stringify(entry));
        },
      },
    },
  );
  return app.ok ? ok(app.value.handler) : app;
});
