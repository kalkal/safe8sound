import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { z } from 'zod';

export const StageNameSchema = z.enum(['dev', 'demo']);
export type StageName = z.infer<typeof StageNameSchema>;

const positiveInt = z.number().int().positive();

/** The MCP server Lambda (issue #70). Only parameter NAMES live here, never token values. */
export const McpConfigSchema = z.strictObject({
  /**
   * SSM SecureString with `<client>@<homeId>=<token>,...`, under the per-function prefix
   * (plan §12.5): `/<project>/{stage}/mcp-server/<name>`; `{stage}` is replaced by the stage name.
   */
  clientsParameter: z.string().regex(/^\/[a-z0-9-]+\/\{stage\}\/mcp-server\/[A-Za-z0-9_.-]+$/),
  /**
   * Optional. Absent = unreserved. New accounts have a concurrency limit of 10 and AWS keeps 10
   * unreserved, so any value fails at deploy until the quota is raised (>= 200, plan §14.3).
   */
  reservedConcurrency: z.strictObject({ dev: positiveInt, demo: positiveInt }).optional(),
  memoryMb: z.number().int().min(128).max(10_240),
  timeoutSeconds: z.number().int().min(1).max(900),
  /** One of the retention periods CloudWatch Logs offers (1, 3, 5, 7, 14, 30, ...). */
  logRetentionDays: z.enum(RetentionDays),
  /** Alarm threshold: tools must answer in under 500 ms p95 warm (plan §1 principle 9). */
  p95AlarmMs: positiveInt,
  ssmTimeoutMs: positiveInt,
  allowedOrigins: z.array(z.url()),
  scenario: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
  /**
   * Where scenario time starts (R1): `daily` = midnight in the scenario's own offset (it replays every
   * day), or a fixed ISO instant. Never the container start (the server default for local runs): two
   * warm Lambdas would disagree. With a fixed instant the simulator stops at the end of the scenario
   * (24-36 h later), so use it only for a recording session.
   */
  scenarioAnchor: z.union([z.literal('daily'), z.iso.datetime({ offset: true })]),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

/** SDK settings of the DynamoDB state store, passed to every Lambda that uses it. */
export const StateConfigSchema = z.strictObject({
  connectTimeoutMs: positiveInt,
  requestTimeoutMs: positiveInt,
  maxAttempts: positiveInt,
});
export type StateConfig = z.infer<typeof StateConfigSchema>;

/** The agent on AgentCore Runtime (#17, G1b). Model ids and names only: never a token value. */
export const AgentConfigSchema = z.strictObject({
  /** The inference profile the agent calls (Nova 2 Lite: `us.amazon.nova-2-lite-v1:0` in us-east-1). */
  modelId: z.string().regex(/^(us|eu|apac|global)\.[a-z0-9-]+\.[a-z0-9.-]+:\d+$/),
  /** The model behind the profile, for the IAM policy (the profile routes to it in several regions). */
  foundationModelId: z.string().regex(/^[a-z0-9-]+\.[a-z0-9.-]+:\d+$/),
  /** SSM SecureString with the agent's MCP token, under `/<project>/{stage}/agent/`. */
  mcpTokenParameter: z.string().regex(/^\/[a-z0-9-]+\/\{stage\}\/agent\/[A-Za-z0-9_.-]+$/),
  /** Idle sessions end after this many seconds (plan §13.2.4: 120; the AgentCore default is 900). */
  idleRuntimeSessionTimeoutSeconds: z.number().int().min(60).max(28_800),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

const simApiParameter = z.string().regex(/^\/[a-z0-9-]+\/\{stage\}\/sim-api\/[A-Za-z0-9_.-]+$/);
/** An exact origin: scheme, host and optional port, no path (CORS compares origins exactly). */
const origin = z.url().refine((u) => new URL(u).origin === u, { message: 'An origin has no path or trailing slash.' });

/**
 * The sim-api Lambda (#17): the demo API the web simulator calls. Only parameter NAMES live here, never
 * the codes, keys or tokens; `{stage}` is replaced by the stage name.
 */
export const SimApiConfigSchema = z
  .strictObject({
    demoCodesParameter: simApiParameter,
    tokenKeysParameter: simApiParameter,
    mcpTokenParameter: simApiParameter,
    /** Optional, as for the MCP server: a new account cannot reserve any until the quota is raised. */
    reservedConcurrency: z.strictObject({ dev: positiveInt, demo: positiveInt }).optional(),
    memoryMb: z.number().int().min(128).max(10_240),
    timeoutSeconds: z.number().int().min(1).max(900),
    logRetentionDays: z.enum(RetentionDays),
    p95AlarmMs: positiveInt,
    ssmTimeoutMs: positiveInt,
    agentTimeoutMs: z.number().int().min(100).max(30_000),
    mcpTimeoutMs: z.number().int().min(100).max(30_000),
    /** The simulator's origins; empty until the web stack lands (the function then answers invalid_config). */
    allowedOrigins: z.array(origin),
    /** Kill switch per stage (plan §13.2.4). */
    demoEnabled: z.strictObject({ dev: z.boolean(), demo: z.boolean() }),
    tokenTtlS: z.number().int().min(60).max(3600),
    limits: z.strictObject({
      turnsPerCodePerDay: z.number().int().min(1).max(10_000),
      turnsGlobalPerDay: z.number().int().min(1).max(100_000),
      toolCallsPerCodePerDay: z.number().int().min(1).max(10_000),
      codeAttemptsPerIpPerHour: z.number().int().min(1).max(1000),
    }),
  })
  .refine((c) => c.agentTimeoutMs < c.timeoutSeconds * 1000, { message: 'The agent timeout must end before the function timeout.', path: ['agentTimeoutMs'] });
export type SimApiConfig = z.infer<typeof SimApiConfigSchema>;

export const InfraConfigSchema = z.strictObject({
  /** AWS region, e.g. us-east-1. Never hard-coded in stacks. */
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
  stages: z.array(StageNameSchema).min(1),
  mcp: McpConfigSchema,
  state: StateConfigSchema,
  agent: AgentConfigSchema,
  simApi: SimApiConfigSchema,
})
  .superRefine((c, ctx) => {
    // The sim-api worst case (Copilot on #156): the SSM reads at a cold start, two DynamoDB calls with every
    // attempt (a turn counts per code and overall), the agent or the MCP server, and 1 s for the SDK backoff.
    // It must end before the function does, so the caller gets our answer, never a raw 502.
    const dynamo = 2 * c.state.maxAttempts * (c.state.connectTimeoutMs + c.state.requestTimeoutMs);
    const worstMs = c.simApi.ssmTimeoutMs + dynamo + Math.max(c.simApi.agentTimeoutMs, c.simApi.mcpTimeoutMs) + 1000;
    if (worstMs > c.simApi.timeoutSeconds * 1000) {
      ctx.addIssue({ code: 'custom', path: ['simApi', 'timeoutSeconds'], message: `The sim-api worst case is ${String(worstMs)} ms: raise timeoutSeconds, or lower the timeouts or the DynamoDB attempts.` });
    }
  });
export type InfraConfig = z.infer<typeof InfraConfigSchema>;

/** Reads the `cold-reserve:*` keys of the CDK context (cdk.json or `-c key=value`). */
export function loadInfraConfig(context: (key: string) => unknown): Result<InfraConfig, ErrorEnvelope> {
  const parsed = InfraConfigSchema.safeParse({
    region: context('cold-reserve:region'),
    stages: context('cold-reserve:stages'),
    mcp: context('cold-reserve:mcp'),
    state: context('cold-reserve:state'),
    agent: context('cold-reserve:agent'),
    simApi: context('cold-reserve:simApi'),
  });
  if (parsed.success) return ok(parsed.data);
  return err(
    toolError('invalid_config', 'The CDK context has no valid cold-reserve:region, :stages, :mcp, :state, :agent or :simApi.', {
      details: { issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message.slice(0, 200) })) },
    }),
  );
}
