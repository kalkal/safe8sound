import { randomBytes } from 'node:crypto';
import type { Clock } from '@cold-reserve/core';
import type { ParameterReader } from '@cold-reserve/ssm-parameters';
import { dynamoSettingsFrom, type DynamoClientSettings } from '@cold-reserve/store-dynamodb';
import { err, ok, toolError, type ErrorEnvelope, type LogEntry, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';
import { agentCoreTurnAgent, type AgentCoreClientLike } from './adapters/agentcore.js';
import { mcpCardTools, streamableMcpCaller } from './adapters/mcp-cards.js';
import { loadPlainSimApiSettings, loadSimApiConfig } from './config.js';
import { createSimApiHandler, type SimApiHandler } from './handler.js';
import type { QuotaStore } from './quota.js';

const SettingsSchema = z.object({
  SIM_DEMO_CODES_PARAMETER: z.string().regex(/^\/[\w./-]+$/),
  SIM_TOKEN_KEYS_PARAMETER: z.string().regex(/^\/[\w./-]+$/),
  SIM_MCP_TOKEN_PARAMETER: z.string().regex(/^\/[\w./-]+$/),
  AGENT_RUNTIME_ARN: z.string().regex(/^arn:aws[\w-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/[\w-]+$/),
  SIM_AGENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(7500),
  SIM_MCP_URL: z.url(),
  SIM_MCP_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3000),
});

export interface SimApiLambdaDeps {
  /** Reads one SecureString (the Parameters and Secrets extension on Lambda). */
  readonly read: ParameterReader;
  readonly agentCore: AgentCoreClientLike;
  /** The caps on the shared table: one atomic counter per key (decided in #17). */
  readonly quotaFor: (table: { tableName: string; client: DynamoClientSettings }) => QuotaStore;
  readonly log: (entry: LogEntry) => void;
  readonly clock: Clock;
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

  const [demoCodes, tokenKeys, mcpToken] = await Promise.all([deps.read(s.SIM_DEMO_CODES_PARAMETER), deps.read(s.SIM_TOKEN_KEYS_PARAMETER), deps.read(s.SIM_MCP_TOKEN_PARAMETER)]);
  if (!demoCodes.ok) return demoCodes;
  if (!tokenKeys.ok) return tokenKeys;
  if (!mcpToken.ok) return mcpToken;
  if (mcpToken.value.length < 32) return err(toolError('invalid_config', 'The MCP token parameter holds fewer than 32 characters.'));

  const config = loadSimApiConfig({ ...env, SIM_DEMO_CODES: demoCodes.value, SIM_TOKEN_KEYS: tokenKeys.value });
  if (!config.ok) return config;

  return ok(
    createSimApiHandler(config.value, {
      agent: agentCoreTurnAgent({ runtimeArn: s.AGENT_RUNTIME_ARN, timeoutMs: s.SIM_AGENT_TIMEOUT_MS, client: deps.agentCore, log: deps.log }),
      tools: mcpCardTools({ caller: streamableMcpCaller({ url: s.SIM_MCP_URL, token: mcpToken.value }), timeoutMs: s.SIM_MCP_TIMEOUT_MS }),
      quota: deps.quotaFor(table.value),
      clock: deps.clock,
      randomHex: () => randomBytes(8).toString('hex'),
      logger: { log: deps.log },
    }),
  );
}
