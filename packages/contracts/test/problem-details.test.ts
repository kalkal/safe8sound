import { describe, expect, it } from 'vitest';
import {
  ErrorCategorySchema,
  PROBLEM_JSON_CONTENT_TYPE,
  ProblemDetailsSchema,
  httpStatusOf,
  toProblemDetails,
  toolError,
} from '../src/index.js';

describe('RFC 9457 Problem Details', () => {
  it('maps every category to one HTTP status', () => {
    const statuses = Object.fromEntries(ErrorCategorySchema.options.map((c) => [c, httpStatusOf(c)]));
    expect(statuses).toEqual({
      validation: 400,
      guard_rejection: 422,
      not_found: 404,
      unauthorized: 401,
      forbidden: 403,
      conflict: 409,
      dependency_unavailable: 503,
      rate_limited: 429,
      internal: 500,
    });
  });

  it('builds a problem from an error envelope with the correlation id as instance', () => {
    const problem = toProblemDetails(toolError('missing_token', 'A bearer token is required.'), {
      instance: 'urn:uuid:5f0c7c1e-3f55-4a3e-9d1c-1b2a3c4d5e6f',
    });
    expect(problem).toEqual({
      type: 'urn:cold-reserve:problem:missing_token',
      title: 'Unauthorized',
      status: 401,
      detail: 'A bearer token is required.',
      instance: 'urn:uuid:5f0c7c1e-3f55-4a3e-9d1c-1b2a3c4d5e6f',
      code: 'missing_token',
    });
    expect(ProblemDetailsSchema.safeParse(problem).success).toBe(true);
  });

  it('keeps retryAfterMs for rate limits', () => {
    const problem = toProblemDetails(toolError('demo_quota_exceeded', 'Daily demo limit reached.', { retryAfterMs: 3_600_000 }), {
      instance: 'urn:uuid:00000000-0000-4000-8000-000000000000',
    });
    expect(problem.status).toBe(429);
    expect(problem.retryAfterMs).toBe(3_600_000);
  });

  it('never carries internal details such as stack traces', () => {
    expect(
      ProblemDetailsSchema.safeParse({
        type: 'urn:cold-reserve:problem:unexpected_error',
        title: 'Internal error',
        status: 500,
        detail: 'Something went wrong.',
        instance: 'urn:uuid:00000000-0000-4000-8000-000000000000',
        code: 'unexpected_error',
        stack: 'Error: boom\n    at handler',
      }).success,
    ).toBe(false);
  });

  it('uses the problem+json media type', () => {
    expect(PROBLEM_JSON_CONTENT_TYPE).toBe('application/problem+json');
  });
});
