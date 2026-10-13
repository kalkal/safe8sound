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

/**
 * The classic Alexa skill bridge (#26): a thin Lambda that calls the MCP server with its own `read:alexa@demo` token.
 * Only the token parameter NAME lives here; the skill ID is given at deploy time (`-c alexaSkillId=...`), never
 * committed, and without it the stack is not created at all.
 */
export const AlexaConfigSchema = z
  .strictObject({
    /** The stages that get the skill function when a skill ID is given. */
    stages: z.array(StageNameSchema).min(1),
    /** SSM SecureString with the skill's MCP token, under `/<project>/{stage}/alexa-skill/`. */
    tokenParameter: z.string().regex(/^\/[a-z0-9-]+\/\{stage\}\/alexa-skill\/[A-Za-z0-9_.-]+$/),
    memoryMb: z.number().int().min(128).max(10_240),
    /** Alexa waits 8 s for the skill: the function stops before. */
    timeoutSeconds: z.number().int().min(1).max(7),
    logRetentionDays: z.enum(RetentionDays),
    /** Optional, as for the other functions: a new account cannot reserve any until the quota is raised. */
    reservedConcurrency: positiveInt.optional(),
    /** The latency budget of one request: the whole request, the SSM read inside it, the MCP call inside it. */
    deadlineMs: positiveInt,
    ssmTimeoutMs: positiveInt,
    mcpTimeoutMs: positiveInt,
    /** The unit the skill says temperatures in (the demo home's own). */
    tempUnit: z.enum(['C', 'F']),
  })
  .refine((a) => a.ssmTimeoutMs + a.mcpTimeoutMs <= a.deadlineMs, { path: ['deadlineMs'], message: 'The SSM read and the MCP call must fit in the deadline.' })
  .refine((a) => a.deadlineMs < a.timeoutSeconds * 1000, { path: ['timeoutSeconds'], message: 'The function must outlive the deadline, so Alexa always gets our answer.' });
export type AlexaConfig = z.infer<typeof AlexaConfigSchema>;

/** An Alexa skill ID (`amzn1.ask.skill.<uuid>`), given only on the command line at deploy time. */
export const AlexaSkillIdSchema = z.string().regex(/^amzn1\.ask\.skill\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

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
    /**
     * The origin secret CloudFront adds to every /api request, and the previous one during a rotation (#243). SSM
     * String parameters (CloudFront cannot resolve ssm-secure; Secrets Manager would cost money): created by the owner.
     */
    originSecretParameter: simApiParameter,
    originSecretPreviousParameter: simApiParameter,
    /** sim-api's sandbox phone token (#267): the MCP server's phone:<role>@demo#* entry, read for the visitor's phone panel. */
    phoneTokenParameter: simApiParameter,
    /** Optional, as for the MCP server: a new account cannot reserve any until the quota is raised. */
    reservedConcurrency: z.strictObject({ dev: positiveInt, demo: positiveInt }).optional(),
    memoryMb: z.number().int().min(128).max(10_240),
    timeoutSeconds: z.number().int().min(1).max(900),
    logRetentionDays: z.enum(RetentionDays),
    p95AlarmMs: positiveInt,
    ssmTimeoutMs: positiveInt,
    mcpTimeoutMs: z.number().int().min(100).max(30_000),
    /** Extra origins allowed to call sim-api directly (CORS). Empty on AWS: the site calls it same-origin at /api (K1, #244). */
    allowedOrigins: z.array(origin),
    /** Kill switch per stage (plan §13.2.4). */
    demoEnabled: z.strictObject({ dev: z.boolean(), demo: z.boolean() }),
    tokenTtlS: z.number().int().min(60).max(3600),
    limits: z.strictObject({
      turnsPerCodePerDay: z.number().int().min(1).max(10_000),
      turnsGlobalPerDay: z.number().int().min(1).max(100_000),
      toolCallsPerCodePerDay: z.number().int().min(1).max(10_000),
      /** Card reads (contracts CARD_TOOL_ACCESS) per demo code and overall per UTC day (#334): reads never use up the writes. */
      readCallsPerCodePerDay: z.number().int().min(1).max(10_000),
      readCallsGlobalPerDay: z.number().int().min(1).max(1_000_000),
      /** The simulated clock and the scenario (set_scenario, get_milestones, advance_clock) per demo code per UTC day (time pack). */
      demoCallsPerCodePerDay: z.number().int().min(1).max(10_000),
      codeAttemptsPerIpPerHour: z.number().int().min(1).max(1000),
      /** Characters Polly may speak per demo code and overall per UTC day; cache hits are free (approved in #25). */
      speechCharsPerCodePerDay: z.number().int().min(1).max(1_000_000),
      speechCharsGlobalPerDay: z.number().int().min(1).max(10_000_000),
      /** Phone panel reads per minute, per session and per demo code (#294): a panel polls every 5 s, 12 a minute. */
      phoneReadsPerSessionPerMinute: z.number().int().min(1).max(600),
      phoneReadsPerCodePerMinute: z.number().int().min(1).max(600),
      /** Browser log lines (POST /v1/log, #125) per minute, per session and overall: a few lines a minute is a broken page. */
      logLinesPerSessionPerMinute: z.number().int().min(1).max(600),
      logLinesGlobalPerMinute: z.number().int().min(1).max(10_000),
    }),
    /** The studio voice (F8d, #25, approved in #25): on per stage, one voice, the S3 cache of spoken replies. */
    speech: z.strictObject({
      enabled: z.strictObject({ dev: z.boolean(), demo: z.boolean() }),
      engine: z.enum(['neural', 'generative', 'standard']),
      /** One setting: the final voice is the owner's choice. */
      voice: z.string().regex(/^[A-Z][A-Za-z]{1,31}$/),
      pollyTimeoutMs: z.number().int().min(100).max(10_000),
      cacheTimeoutMs: z.number().int().min(100).max(10_000),
      cacheDays: z.number().int().min(1).max(365),
    }),
  });
export type SimApiConfig = z.infer<typeof SimApiConfigSchema>;

/**
 * The one timing table of a turn (#270, approved in #270): every wait derives from it, so they can never cross.
 * The agent closes its turn first; sim-api waits for it its deadline plus a margin; the browser waits for sim-api a
 * little longer, so it reads sim-api's honest failure rather than giving up first; the turn budget covers the whole
 * turn on screen; the sim-api function outlives them all. Sized for a cold AgentCore start (8.2 s seen on dev).
 */
export const TurnTimingSchema = z.strictObject({
  agentDeadlineMs: z.number().int().min(1000).max(30_000),
  agentMarginMs: z.number().int().min(500).max(10_000),
  browserTimeoutMs: z.number().int().min(1000).max(60_000),
  turnBudgetMs: z.number().int().min(1000).max(60_000),
});
export type TurnTiming = z.infer<typeof TurnTimingSchema>;

/** How long sim-api waits for the agent: the agent's own deadline plus the margin. */
export const simApiAgentTimeoutMs = (t: TurnTiming): number => t.agentDeadlineMs + t.agentMarginMs;

export const InfraConfigSchema = z.strictObject({
  /** AWS region, e.g. us-east-1. Never hard-coded in stacks. */
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
  stages: z.array(StageNameSchema).min(1),
  mcp: McpConfigSchema,
  state: StateConfigSchema,
  agent: AgentConfigSchema,
  simApi: SimApiConfigSchema,
  turnTiming: TurnTimingSchema,
  alexa: AlexaConfigSchema,
})
  .superRefine((c, ctx) => {
    // The sim-api worst case (Copilot on #156): the SSM reads at a cold start, two DynamoDB calls with every
    // attempt (a turn counts per code and overall), the agent or the MCP server, and 1 s for the SDK backoff.
    // It must end before the function does, so the caller gets our answer, never a raw 502.
    // A spoken reply (F8d, #25) adds its own path: the cache read and write, two counts and, when Polly fails,
    // two refunds, then Polly.
    const dynamoCallMs = c.state.maxAttempts * (c.state.connectTimeoutMs + c.state.requestTimeoutMs);
    const agentMs = simApiAgentTimeoutMs(c.turnTiming);
    // The chain of waits (#270): each one ends after the one it waits for, counted from the moment sim-api calls the
    // agent. sim-api's own steps before it (cold start, SSM, the quota counts) take well under a second when warm,
    // inside the 2 s between sim-api's wait and the browser's; their worst case is bounded by the function's time
    // budget below, not by this chain: then the browser may stop first and show its own timeout (docs/agentcore.md).
    if (!(agentMs < c.turnTiming.browserTimeoutMs)) {
      ctx.addIssue({ code: 'custom', path: ['turnTiming', 'browserTimeoutMs'], message: `The browser must wait longer than sim-api waits for the agent (${String(agentMs)} ms).` });
    }
    if (!(c.turnTiming.browserTimeoutMs < c.turnTiming.turnBudgetMs)) {
      ctx.addIssue({ code: 'custom', path: ['turnTiming', 'turnBudgetMs'], message: 'The turn budget must be longer than the browser wait.' });
    }
    if (!(c.turnTiming.turnBudgetMs <= c.simApi.timeoutSeconds * 1000)) {
      ctx.addIssue({ code: 'custom', path: ['turnTiming', 'turnBudgetMs'], message: 'The turn budget must fit in the sim-api function timeout.' });
    }
    const turnMs = c.simApi.ssmTimeoutMs + 2 * dynamoCallMs + Math.max(agentMs, c.simApi.mcpTimeoutMs) + 1000;
    const speechMs = c.simApi.ssmTimeoutMs + 2 * c.simApi.speech.cacheTimeoutMs + 4 * dynamoCallMs + c.simApi.speech.pollyTimeoutMs + 1000;
    const worstMs = Math.max(turnMs, speechMs);
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
    turnTiming: context('cold-reserve:turnTiming'),
    alexa: context('cold-reserve:alexa'),
  });
  if (parsed.success) return ok(parsed.data);
  return err(
    toolError('invalid_config', 'The CDK context has no valid cold-reserve:region, :stages, :mcp, :state, :agent, :simApi, :turnTiming or :alexa.', {
      details: { issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message.slice(0, 200) })) },
    }),
  );
}
