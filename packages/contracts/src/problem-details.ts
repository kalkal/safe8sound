import { z } from 'zod';
import { ErrorCodeSchema, type ErrorCategory, type ErrorEnvelope } from './errors.js';

// HTTP errors as RFC 9457 Problem Details (https://www.rfc-editor.org/rfc/rfc9457.html).

export const PROBLEM_JSON_CONTENT_TYPE = 'application/problem+json';

const HTTP: Record<ErrorCategory, { status: number; title: string }> = {
  validation: { status: 400, title: 'Invalid request' },
  guard_rejection: { status: 422, title: 'Rejected by the guard' },
  not_found: { status: 404, title: 'Not found' },
  unauthorized: { status: 401, title: 'Unauthorized' },
  forbidden: { status: 403, title: 'Forbidden' },
  conflict: { status: 409, title: 'Conflict' },
  dependency_unavailable: { status: 503, title: 'Service unavailable' },
  rate_limited: { status: 429, title: 'Too many requests' },
  internal: { status: 500, title: 'Internal error' },
};

export const httpStatusOf = (category: ErrorCategory): number => HTTP[category].status;

/** No stack traces, internal ids or secrets: the object is closed. `instance` is the correlation id. */
export const ProblemDetailsSchema = z.strictObject({
  type: z.string().regex(/^urn:cold-reserve:problem:[a-z][a-z0-9_]*$/),
  title: z.string().min(1).max(100),
  status: z.number().int().min(400).max(599),
  detail: z.string().min(1).max(300),
  instance: z.string().min(1).max(200),
  code: ErrorCodeSchema,
  retryAfterMs: z.number().int().nonnegative().optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

type Upto<N extends number, Acc extends number[] = []> = Acc['length'] extends N ? Acc[number] : Upto<N, [...Acc, Acc['length']]>;

/** An HTTP error status: the integers 400 to 599, checked by the compiler and again at runtime. */
export type HttpErrorStatus = Exclude<Upto<600>, Upto<400>>;

const isHttpErrorStatus = (n: number): boolean => Number.isInteger(n) && n >= 400 && n <= 599;

/**
 * `status` overrides the category status where HTTP needs a more precise one (405, 413).
 * A status outside 400-599 is a bug in the caller, so it throws.
 */
export function toProblemDetails(error: ErrorEnvelope, context: { instance: string; status?: HttpErrorStatus }): ProblemDetails {
  const { title } = HTTP[error.category];
  if (context.status !== undefined && !isHttpErrorStatus(context.status)) {
    throw new RangeError(`Problem status must be an integer from 400 to 599, got ${String(context.status)}`);
  }
  const status = context.status ?? HTTP[error.category].status;
  return {
    type: `urn:cold-reserve:problem:${error.code}`,
    title,
    status,
    detail: error.message,
    instance: context.instance,
    code: error.code,
    ...(error.retryAfterMs !== undefined && { retryAfterMs: error.retryAfterMs }),
  };
}
