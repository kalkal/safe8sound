import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { PollyClient } from '@aws-sdk/client-polly';
import { S3Client } from '@aws-sdk/client-s3';
import { err, toolError, type LogEntry } from '@cold-reserve/contracts';
import { jsonLineSink, loggerTo } from '@cold-reserve/core';
import { extensionReader } from '@cold-reserve/ssm-parameters';
import { dynamoCounter, sdkDocumentSender } from '@cold-reserve/store-dynamodb';
import { pollySpeech } from './adapters/polly.js';
import { s3SpeechCache } from './adapters/speech-cache-s3.js';
import { createSimApiLambda } from './lambda.js';
import { loadSimApiLambda } from './lambda-wiring.js';

// Lambda entry (#17, the sim-api stack): the secrets come from SSM SecureStrings through the Parameters and
// Secrets extension, the agent is the AgentCore runtime, the caps live in the shared table. Every line is
// the shared LogEntry, one JSON line on stdout.
const logger = loggerTo(
  jsonLineSink((text) => {
    process.stdout.write(text);
  }),
);
const log = (entry: LogEntry) => {
  logger.log(entry);
};

export const handler = createSimApiLambda(
  async () => {
    const sessionToken = process.env['AWS_SESSION_TOKEN'];
    if (!sessionToken) return err(toolError('invalid_config', 'AWS_SESSION_TOKEN is not set.'));
    return loadSimApiLambda(process.env, {
      read: extensionReader({ fetchFn: fetch, sessionToken, timeoutMs: process.env['SSM_TIMEOUT_MS'] }),
      // One attempt: the adapter has its own timeout, and the caller retries a turn, never the SDK.
      agentCore: new BedrockAgentCoreClient({ maxAttempts: 1 }),
      quotaFor: (table) => dynamoCounter({ tableName: table.tableName, sender: sdkDocumentSender(table.client) }),
      log,
      clock: { now: Date.now },
      // The studio voice (F8d, #25): one attempt each, the adapters have their own timeouts and the browser
      // voice reads the reply meanwhile.
      speech: (settings) => ({
        synth: pollySpeech({ client: new PollyClient({ maxAttempts: 1 }), timeoutMs: settings.pollyTimeoutMs, log }),
        cache: s3SpeechCache({ client: new S3Client({ maxAttempts: 1 }), bucket: settings.bucket, timeoutMs: settings.cacheTimeoutMs }),
      }),
    });
  },
  { log },
);
