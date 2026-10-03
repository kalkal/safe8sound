import { z } from 'zod';
import { IsoDateTimeSchema } from './common.js';
import { GuaranteeIdSchema, GuaranteeResultSchema } from './guarantees.js';
import { DataOriginSchema } from './origin.js';
import { LevelSchema } from './pacing.js';
import { MeasureUnitSchema } from './units.js';

// Error taxonomy shared by every package (docs/error-handling.md §2).
// New codes are added here only, and only compatibly (never renamed or re-categorised).

export const ErrorCategorySchema = z.enum([
  'validation',
  'guard_rejection',
  'not_found',
  'unauthorized',
  'forbidden',
  'conflict',
  'dependency_unavailable',
  'rate_limited',
  'internal',
]);
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export const ERROR_CATALOG = {
  // validation: the caller or the model fixes the input
  invalid_input: { category: 'validation' },
  invalid_setpoint: { category: 'validation' },
  unknown_room: { category: 'validation' },
  /** notify_family named only roles that are not registered contacts (approved in #23). */
  recipient_not_registered: { category: 'validation' },
  plan_expired: { category: 'validation' },
  /** apply_plan got a last-resort token that is wrong, expired or already used (approved in #160). */
  last_resort_token_invalid: { category: 'validation' },
  safety_threshold_out_of_range: { category: 'validation' },
  // HTTP transport (MCP server, F3): sent with their own status through toProblemDetails
  method_not_allowed: { category: 'validation' },
  payload_too_large: { category: 'validation' },
  route_not_found: { category: 'validation' },
  missing_protocol_version: { category: 'validation' },
  // guard_rejection: the model re-plans (one code per guarantee)
  storm_reserve_violated: { category: 'guard_rejection' },
  inverter_limit_exceeded: { category: 'guard_rejection' },
  battery_power_exceeded: { category: 'guard_rejection' },
  safe_room_comfort_violated: { category: 'guard_rejection' },
  pacing_off_track: { category: 'guard_rejection' },
  night_recovery_unmet: { category: 'guard_rejection' },
  // not_found
  plan_not_found: { category: 'not_found' },
  home_not_found: { category: 'not_found' },
  // unauthorized / forbidden: configuration
  missing_token: { category: 'unauthorized' },
  wrong_client: { category: 'unauthorized' },
  invalid_signature: { category: 'unauthorized' },
  // A wrong demo code at POST /v1/session (approved in #101); never says whether the code exists.
  invalid_demo_code: { category: 'unauthorized' },
  signature_expired: { category: 'unauthorized' },
  origin_not_allowed: { category: 'forbidden' },
  demo_disabled: { category: 'forbidden' },
  // A sandbox home header the client may not use (approved in #101).
  home_not_allowed: { category: 'forbidden' },
  // A plan built on simulated data is never applied to the real home (plan §9.4, approved in #19).
  simulated_plan_on_real_home: { category: 'forbidden' },
  // conflict: idempotent success, return the original outcome
  plan_already_applied: { category: 'conflict' },
  // dependency_unavailable: transient, retry with backoff then degrade
  home_data_stale: { category: 'dependency_unavailable' },
  split_cloud_unreachable: { category: 'dependency_unavailable' },
  forecast_unavailable: { category: 'dependency_unavailable' },
  bedrock_throttled: { category: 'dependency_unavailable' },
  agent_timeout: { category: 'dependency_unavailable' },
  agent_unavailable: { category: 'dependency_unavailable' },
  polly_unavailable: { category: 'dependency_unavailable' },
  store_unavailable: { category: 'dependency_unavailable' },
  /** The configuration store (SSM) timed out or failed at startup: retried on the next request (#112). */
  config_unavailable: { category: 'dependency_unavailable' },
  /** A device made safe before a storm did not answer (approved in #172): recorded as failed, the storm goes on. */
  device_unreachable: { category: 'dependency_unavailable' },
  // rate_limited: wait retryAfterMs
  demo_quota_exceeded: { category: 'rate_limited' },
  /** A family phone replied again too soon (per role, approved in #24). */
  family_reply_rate_limited: { category: 'rate_limited' },
  /** A second question for a home while one is still running (#101): retry after retryAfterMs. */
  turn_in_progress: { category: 'rate_limited' },
  // internal: a bug, alert
  unexpected_error: { category: 'internal' },
  output_schema_violation: { category: 'internal' },
  invalid_config: { category: 'internal' },
  /** A storm calculation on a home profile without `epsBaseLoadW`: refused, never assumed (#107). */
  missing_eps_load: { category: 'internal' },
} as const satisfies Record<string, { category: ErrorCategory }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;
export const ERROR_CODES = Object.keys(ERROR_CATALOG) as [ErrorCode, ...ErrorCode[]];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const categoryOf = (code: ErrorCode): ErrorCategory => ERROR_CATALOG[code].category;

const RETRYABLE: ReadonlySet<ErrorCategory> = new Set(['dependency_unavailable', 'rate_limited']);
/** Only transient failures are retried (docs/error-handling.md §4). */
export const isRetryableCategory = (category: ErrorCategory): boolean => RETRYABLE.has(category);

/** Typed error details: a closed set of fields, never free-form data, stacks or secrets. */
export const ErrorDetailsSchema = z.strictObject({
  /** Dotted path of the offending input field. */
  field: z.string().min(1).max(120).optional(),
  issues: z
    .array(z.strictObject({ path: z.string().max(120), message: z.string().min(1).max(200) }))
    .max(20)
    .optional(),
  guarantee: GuaranteeIdSchema.optional(),
  measured: z.number().optional(),
  limit: z.number().optional(),
  nearestAllowed: z.number().optional(),
  unit: MeasureUnitSchema.optional(),
  ageSeconds: z.number().int().nonnegative().optional(),
  planId: z.string().min(1).max(64).optional(),
  roomId: z.string().min(1).max(64).optional(),
  /** A guard refusal's whole verdict, for the REJECTED receipt card (approved in #186): at most the five rows. */
  guarantees: z.array(GuaranteeResultSchema).max(5).optional(),
  /** Next to a refusal, the plan the planner would accept: its level and until when (approved in #186). */
  alternative: z.strictObject({ level: LevelSchema, until: IsoDateTimeSchema }).optional(),
  /** Where a refusal's data came from, for the receipt's LIVE/SIMULATED badge (approved in #198). */
  origin: DataOriginSchema.optional(),
  /** Present, true, only when the refusal is about the real home: never a home id in tool output (approved in #198). */
  realHome: z.literal(true).optional(),
});
export type ErrorDetails = z.infer<typeof ErrorDetailsSchema>;

/** The error envelope: MCP `structuredContent` with `isError: true`, and the base of HTTP problems. */
export const ErrorEnvelopeSchema = z
  .strictObject({
    code: ErrorCodeSchema,
    category: ErrorCategorySchema,
    /** Short, actionable English text. */
    message: z.string().min(1).max(300),
    retryable: z.boolean(),
    retryAfterMs: z.number().int().nonnegative().optional(),
    details: ErrorDetailsSchema.optional(),
  })
  .superRefine((e, ctx) => {
    if (categoryOf(e.code) !== e.category) {
      ctx.addIssue({ code: 'custom', path: ['category'], message: `"${e.code}" belongs to "${categoryOf(e.code)}"` });
    }
    if (isRetryableCategory(e.category) !== e.retryable) {
      ctx.addIssue({ code: 'custom', path: ['retryable'], message: `retryable must be ${String(isRetryableCategory(e.category))}` });
    }
    if (e.retryAfterMs !== undefined && !e.retryable) {
      ctx.addIssue({ code: 'custom', path: ['retryAfterMs'], message: 'retryAfterMs only applies to retryable errors' });
    }
  });
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/** Builds a consistent envelope: category and retryable come from the catalog. */
export function toolError(
  code: ErrorCode,
  message: string,
  extra: { retryAfterMs?: number; details?: ErrorDetails } = {},
): ErrorEnvelope {
  const category = categoryOf(code);
  return {
    code,
    category,
    message,
    retryable: isRetryableCategory(category),
    ...(extra.retryAfterMs !== undefined && { retryAfterMs: extra.retryAfterMs }),
    ...(extra.details !== undefined && { details: extra.details }),
  };
}
