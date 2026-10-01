import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';

// Cost rule (plan, binding): maxTokens <= 400, at most 6 tool calls per turn, the last 6 turns of
// history. These are ceilings: config may lower them, never raise them. The model id and the
// region come from config only (never from code).
const MAX_TOKENS_CEILING = 400;
const MAX_TOOL_CALLS_CEILING = 6;
const HISTORY_MESSAGES_CEILING = 12; // 6 turns = 6 user + 6 assistant messages
const TURN_DEADLINE_CEILING_MS = 30_000;
// Under sim-api's 8 s scripted fallback (plan §9.2), so the agent answers or fails first.
const DEFAULT_TURN_DEADLINE_MS = 7_000;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MIN_TOKEN_LENGTH = 32;

const intFromEnv = z
  .string()
  .regex(/^\d+$/, 'Expected a whole number')
  .transform(Number)
  .pipe(z.number().int().positive());

const ModelSchema = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('fake') }),
  z.strictObject({ provider: z.literal('bedrock'), modelId: z.string().min(1).max(200), region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/) }),
]);

export const AgentConfigSchema = z
  .strictObject({
    model: ModelSchema,
    maxTokens: intFromEnv.pipe(z.number().max(MAX_TOKENS_CEILING)),
    /** Strands `limits.turns` counts model calls: the tool calls plus the final answer. The real cost cap. */
    maxModelTurns: intFromEnv.pipe(z.number().max(MAX_TOOL_CALLS_CEILING + 1)),
    maxToolCalls: intFromEnv.pipe(z.number().max(MAX_TOOL_CALLS_CEILING)),
    historyWindowMessages: intFromEnv.pipe(z.number().max(HISTORY_MESSAGES_CEILING)),
    /** Explicit deadline of a whole turn: the MCP client's own default is 60 s. */
    turnDeadlineMs: intFromEnv.pipe(z.number().max(TURN_DEADLINE_CEILING_MS)),
    /** https, or plain http only on the loopback (the local MCP server). */
    mcpUrl: z.url({ protocol: /^https?$/ }).refine((u) => new URL(u).protocol === 'https:' || LOOPBACK.has(new URL(u).hostname), { message: 'Use https, or http only on the loopback' }),
  })
  .refine((c) => c.maxModelTurns > c.maxToolCalls, { path: ['maxModelTurns'], message: 'Must leave one model call for the answer' });
export type AgentConfig = z.output<typeof AgentConfigSchema>;

export function loadAgentConfig(env: Readonly<Record<string, string | undefined>>): Result<AgentConfig, ErrorEnvelope> {
  const provider = env['AGENT_MODEL_PROVIDER'] ?? 'fake';
  const parsed = AgentConfigSchema.safeParse({
    model: provider === 'bedrock' ? { provider, modelId: env['AGENT_MODEL_ID'], region: env['AGENT_REGION'] } : { provider },
    maxTokens: env['AGENT_MAX_TOKENS'] ?? String(MAX_TOKENS_CEILING),
    maxModelTurns: env['AGENT_MAX_MODEL_TURNS'] ?? String(MAX_TOOL_CALLS_CEILING + 1),
    maxToolCalls: env['AGENT_MAX_TOOL_CALLS'] ?? String(MAX_TOOL_CALLS_CEILING),
    historyWindowMessages: env['AGENT_HISTORY_WINDOW_MESSAGES'] ?? String(HISTORY_MESSAGES_CEILING),
    turnDeadlineMs: env['AGENT_TURN_DEADLINE_MS'] ?? String(DEFAULT_TURN_DEADLINE_MS),
    mcpUrl: env['AGENT_MCP_URL'] ?? 'http://127.0.0.1:3316/mcp',
  });
  if (parsed.success) return ok(parsed.data);
  return err(
    toolError('invalid_config', 'The agent configuration is not valid.', {
      details: { issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message.slice(0, 200) })) },
    }),
  );
}

/** The agent's bearer token for the MCP server: never inside AgentConfig, redacted when printed. */
export class McpToken {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }
}

/** AGENT_MCP_TOKEN from the environment (locally .env; on AgentCore a secret, after S2). */
export function loadMcpToken(env: Readonly<Record<string, string | undefined>>): Result<McpToken, ErrorEnvelope> {
  return loadToken(env, 'AGENT_MCP_TOKEN');
}

/** AGENT_INVOKE_TOKEN: what sim-api presents to invoke the agent, separate from the MCP token (#101). */
export function loadInvokeToken(env: Readonly<Record<string, string | undefined>>): Result<McpToken, ErrorEnvelope> {
  return loadToken(env, 'AGENT_INVOKE_TOKEN');
}

/** AGENT_MAX_SESSIONS: sandbox homes kept in memory (LRU), 1-1000, default 50. */
export function loadMaxSessions(env: Readonly<Record<string, string | undefined>>): Result<number, ErrorEnvelope> {
  const raw = env['AGENT_MAX_SESSIONS'];
  if (raw === undefined) return ok(50);
  const value = Number(raw.trim());
  return raw.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= 1000
    ? ok(value)
    : err(toolError('invalid_config', 'AGENT_MAX_SESSIONS must be a whole number from 1 to 1000.'));
}

function loadToken(env: Readonly<Record<string, string | undefined>>, name: string): Result<McpToken, ErrorEnvelope> {
  const raw = env[name]?.trim();
  if (!raw) return err(toolError('invalid_config', `${name} is not set.`));
  if (raw.length < MIN_TOKEN_LENGTH) return err(toolError('invalid_config', `${name} is shorter than ${String(MIN_TOKEN_LENGTH)} characters.`));
  return ok(new McpToken(raw));
}
