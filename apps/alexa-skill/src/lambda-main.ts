import { randomUUID } from 'node:crypto';
import { err, toolError, type LogEntry } from '@cold-reserve/contracts';
import { jsonLineSink, loggerTo } from '@cold-reserve/core';
import { cachedOnSuccess, extensionReader } from '@cold-reserve/ssm-parameters';
import { speak, type AlexaResponse } from './alexa.js';
import { loadSkillConfig } from './config.js';
import { handle } from './handler.js';
import { streamableMcpCaller } from './mcp.js';
import { failureSpeech } from './speech.js';

// Lambda entry of the Alexa skill (#26): settings from the environment, the MCP token from SSM through the
// Parameters and Secrets extension (no SDK in the bundle), one JSON line per log entry on stdout.
const logger = loggerTo(
  jsonLineSink((text) => {
    process.stdout.write(text);
  }),
);
const log = (entry: LogEntry) => {
  logger.log(entry);
};

const config = loadSkillConfig(process.env);
const sessionToken = process.env['AWS_SESSION_TOKEN'];

const deps = config.ok
  ? {
      skillId: config.value.skillId,
      token: cachedOnSuccess(async () => {
        if (!sessionToken) return err(toolError('invalid_config', 'AWS_SESSION_TOKEN is not set.'));
        return extensionReader({ fetchFn: fetch, sessionToken, timeoutMs: config.value.timing.ssmTimeoutMs })(config.value.tokenParameter);
      }),
      caller: streamableMcpCaller({ url: config.value.mcpUrl }),
      timing: config.value.timing,
      tempUnit: config.value.tempUnit,
      log,
      newId: randomUUID,
      now: Date.now,
    }
  : undefined;

export const handler = async (event: unknown): Promise<AlexaResponse> => {
  if (deps !== undefined) return handle(event, deps);
  // A broken configuration: said once per request in the log, and an apology to the person.
  const error = config.ok ? toolError('invalid_config', 'The skill is not configured.') : config.error;
  log({ ts: new Date().toISOString(), level: 'error', component: 'alexa-skill', message: error.message, code: error.code, category: error.category, correlationId: randomUUID() });
  return speak(failureSpeech(error));
};
