import { randomBytes } from 'node:crypto';
import type { Clock } from '@cold-reserve/core';
import type { ParameterReader } from '@cold-reserve/ssm-parameters';
import { dynamoSettingsFrom, type DynamoClientSettings } from '@cold-reserve/store-dynamodb';
import { err, ok, toolError, type ErrorEnvelope, type LogEntry, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';
import { agentCoreTurnAgent, type AgentCoreClientLike } from './adapters/agentcore.js';
import { mcpCardTools, streamableMcpCaller } from './adapters/mcp-cards.js';
import { httpPhoneInbox } from './adapters/phone-http.js';
import { loadPlainSimApiSettings, loadSimApiConfig } from './config.js';
import { createSimApiHandler, type SimApiHandler, type SpeechCachePort, type SpeechPort } from './handler.js';
import type { QuotaStore } from './quota.js';

const SettingsSchema = z.object({
  SIM_DEMO_CODES_PARAMETER: z.string().regex(/^\/[\w./-]+$/),
  SIM_TOKEN_KEYS_PARAMETER: z.string().regex(/^\/[\w./-]+$/),
  SIM_MCP_TOKEN_PARAMETER: z.string().regex(/^\/[\w./-]+$/),
  /** The origin secret CloudFront adds to every /api request, and the previous one during a rotation (#243). */
  SIM_ORIGIN_SECRET_PARAMETER: z.string().regex(/^\/[\w./-]+$/),
  SIM_ORIGIN_SECRET_PREVIOUS_PARAMETER: z.string().regex(/^\/[\w./-]+$/),
  AGENT_RUNTIME_ARN: z.string().regex(/^arn:aws[\w-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/[\w-]+$/),
  SIM_AGENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(7500),
  SIM_MCP_URL: z.url(),
  /** sim-api's sandbox phone token (#267): without it the visitor's phone panel has no route. */
  SIM_PHONE_TOKEN_PARAMETER: z.string().regex(/^\/[\w./-]+$/).optional(),
  SIM_MCP_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3000),
  /** The studio voice (F8d part 3, #25): the cache bucket, and timeouts for Polly and for each cache call. */
  SIM_SPEECH_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).optional(),
  SIM_POLLY_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2500),
  SIM_SPEECH_CACHE_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(1000),
});

export interface SpeechSettings {
  readonly bucket: string;
  readonly pollyTimeoutMs: number;
  readonly cacheTimeoutMs: number;
}

export interface SimApiLambdaDeps {
  /** Reads one SecureString (the Parameters and Secrets extension on Lambda). */
  readonly read: ParameterReader;
  readonly agentCore: AgentCoreClientLike;
  /** The caps on the shared table: one atomic counter per key (decided in #17). */
  readonly quotaFor: (table: { tableName: string; client: DynamoClientSettings }) => QuotaStore;
  readonly log: (entry: LogEntry) => void;
  readonly clock: Clock;
  /** Polly and its S3 cache, built only when SIM_SPEECH_ENABLED is on. */
  readonly speech?: (settings: SpeechSettings) => { synth: SpeechPort; cache: SpeechCachePort };
}

/**
 * Builds the sim-api handler for Lambda (#17, the sim-api stack). The demo codes, the token keys and the
 * MCP token come only from SSM SecureStrings named in env, never from plain env; everything else is plain
 * config. Settings are checked before anything is read; messages name settings, never values.
 */
export async function loadSimApiLambda(env: Readonly<Record<string, string | undefined>>, deps: SimApiLambdaDeps): Promise<Result<SimApiHandler, ErrorEnvelope>> {
  const settings = SettingsSchema.safeParse(env);
  if (!settings.success) return err(toolError('invalid_config', `Sim-api settings are not valid: ${settings.error.issues.map((i) => i.path.join('.')).join(', ')}.`));
  const s = settings.data;
  const table = dynamoSettingsFrom(env);
  if (!table.ok) return table;
  // Origins, caps, TTL and the kill switch are checked before any secret is read (Copilot on #156).
  const plain = loadPlainSimApiSettings(env);
  if (!plain.ok) return plain;
  if (plain.value.speech.enabled && s.SIM_SPEECH_BUCKET === undefined) return err(toolError('invalid_config', 'SIM_SPEECH_ENABLED needs SIM_SPEECH_BUCKET, the cache of spoken replies.'));

  const [demoCodes, tokenKeys, mcpToken, originSecret, previousSecret] = await Promise.all([
    deps.read(s.SIM_DEMO_CODES_PARAMETER),
    deps.read(s.SIM_TOKEN_KEYS_PARAMETER),
    deps.read(s.SIM_MCP_TOKEN_PARAMETER),
    deps.read(s.SIM_ORIGIN_SECRET_PARAMETER),
    deps.read(s.SIM_ORIGIN_SECRET_PREVIOUS_PARAMETER),
  ]);
  if (!demoCodes.ok) return demoCodes;
  if (!tokenKeys.ok) return tokenKeys;
  if (!mcpToken.ok) return mcpToken;
  if (!originSecret.ok) return originSecret;
  if (!previousSecret.ok) return previousSecret;
  // Fail closed (#244 round 2): `none` means "no previous secret", never "no check". A current parameter that holds
  // none or nothing (a rotation slip, the two parameters swapped) stops the start instead of opening the door.
  const current = originSecret.value.trim();
  if (current === '' || current === 'none') return err(toolError('invalid_config', 'The origin secret parameter holds no secret: sim-api does not start without its check.'));
  if (mcpToken.value.length < 32) return err(toolError('invalid_config', 'The MCP token parameter holds fewer than 32 characters.'));
  // The sandbox family phone (#267): its token read once at start, kept in memory only, never logged.
  let phoneToken: string | undefined;
  if (s.SIM_PHONE_TOKEN_PARAMETER !== undefined) {
    const read = await deps.read(s.SIM_PHONE_TOKEN_PARAMETER);
    if (!read.ok) return read;
    if (read.value.length < 32) return err(toolError('invalid_config', 'The phone token parameter holds fewer than 32 characters.'));
    phoneToken = read.value;
  }

  // On AWS the origin check is always on (#243): a request without the secret never reaches a route.
  const config = loadSimApiConfig({
    ...env,
    SIM_DEMO_CODES: demoCodes.value,
    SIM_TOKEN_KEYS: tokenKeys.value,
    SIM_ORIGIN_SECRET: originSecret.value, // gitleaks:allow (read from SSM at runtime, no value here)
    SIM_ORIGIN_SECRET_PREVIOUS: previousSecret.value,
  });
  if (!config.ok) return config;
  if (config.value.originSecrets.length === 0) return err(toolError('invalid_config', 'No origin secret: sim-api does not start without its check.'));
  // Said once per container, never the value: after a deploy the log shows the check took.
  deps.log({ ts: new Date(deps.clock.now()).toISOString(), level: 'info', component: 'sim-api', message: 'Origin secret check: on.', correlationId: 'startup', details: { event: 'origin_secret_check', check: 'on' } });

  return ok(
    createSimApiHandler(config.value, {
      agent: agentCoreTurnAgent({ runtimeArn: s.AGENT_RUNTIME_ARN, timeoutMs: s.SIM_AGENT_TIMEOUT_MS, client: deps.agentCore, log: deps.log }),
      tools: mcpCardTools({ caller: streamableMcpCaller({ url: s.SIM_MCP_URL, token: mcpToken.value }), timeoutMs: s.SIM_MCP_TIMEOUT_MS }),
      quota: deps.quotaFor(table.value),
      clock: deps.clock,
      randomHex: () => randomBytes(8).toString('hex'),
      logger: { log: deps.log },
      ...(phoneToken === undefined ? {} : { phone: httpPhoneInbox({ mcpUrl: s.SIM_MCP_URL, token: phoneToken, timeoutMs: s.SIM_MCP_TIMEOUT_MS }) }),
      ...(plain.value.speech.enabled && s.SIM_SPEECH_BUCKET !== undefined && deps.speech !== undefined
        ? { speech: deps.speech({ bucket: s.SIM_SPEECH_BUCKET, pollyTimeoutMs: s.SIM_POLLY_TIMEOUT_MS, cacheTimeoutMs: s.SIM_SPEECH_CACHE_TIMEOUT_MS }) }
        : {}),
    }),
  );
}
