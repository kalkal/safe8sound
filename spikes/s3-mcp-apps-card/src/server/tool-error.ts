import { z } from 'zod';

// Spike-local copy of the S1 envelope (spikes/s1-mcp-server/src/tool-error.ts); the shared one lives in packages/contracts.
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

export const ToolErrorSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  category: ErrorCategorySchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

const RETRYABLE: ReadonlySet<ErrorCategory> = new Set(['dependency_unavailable', 'rate_limited']);

export function toolError(
  code: string,
  category: ErrorCategory,
  message: string,
  extra: { retryAfterMs?: number; details?: Record<string, unknown> } = {},
): ToolError {
  return {
    code,
    category,
    message,
    retryable: RETRYABLE.has(category),
    ...(extra.retryAfterMs !== undefined && { retryAfterMs: extra.retryAfterMs }),
    ...(extra.details !== undefined && { details: extra.details }),
  };
}
