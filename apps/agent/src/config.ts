import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';

// Cost rule (plan, binding): maxTokens <= 400, at most 6 tool calls per turn, the last 6 turns of
// history. These are ceilings: config may lower them, never raise them. The model id and the
// region come from config only (never from code).
const MAX_TOKENS_CEILING = 400;
const MAX_TOOL_CALLS_CEILING = 6;
const HISTORY_MESSAGES_CEILING = 12; // 6 turns = 6 user + 6 assistant messages

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
    mcpUrl: z.url({ protocol: /^https?$/ }),
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
    mcpUrl: env['AGENT_MCP_URL'] ?? 'http://127.0.0.1:3316/mcp',
  });
  if (parsed.success) return ok(parsed.data);
  return err(
    toolError('invalid_config', 'The agent configuration is not valid.', {
      details: { issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message.slice(0, 200) })) },
    }),
  );
}
