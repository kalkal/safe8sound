import { describe, expect, it } from 'vitest';
import { ToolErrorSchema, toolError } from '../src/tool-error.js';

describe('toolError', () => {
  it('builds a valid envelope for every category', () => {
    const categories = [
      'validation',
      'guard_rejection',
      'not_found',
      'unauthorized',
      'forbidden',
      'conflict',
      'dependency_unavailable',
      'rate_limited',
      'internal',
    ] as const;
    for (const category of categories) {
      const err = toolError('some_code', category, 'Something happened.');
      expect(ToolErrorSchema.safeParse(err).success).toBe(true);
    }
  });

  it('marks only dependency_unavailable and rate_limited as retryable', () => {
    expect(toolError('home_data_stale', 'dependency_unavailable', 'x').retryable).toBe(true);
    expect(toolError('demo_quota_exceeded', 'rate_limited', 'x').retryable).toBe(true);
    expect(toolError('home_not_found', 'not_found', 'x').retryable).toBe(false);
    expect(toolError('unexpected_error', 'internal', 'x').retryable).toBe(false);
  });

  it('carries retryAfterMs and details only when given', () => {
    const plain = toolError('home_not_found', 'not_found', 'x');
    expect(plain).not.toHaveProperty('retryAfterMs');
    expect(plain).not.toHaveProperty('details');
    const rich = toolError('home_data_stale', 'dependency_unavailable', 'x', {
      retryAfterMs: 60_000,
      details: { ageSeconds: 1200 },
    });
    expect(rich).toMatchObject({ retryAfterMs: 60_000, details: { ageSeconds: 1200 } });
  });

  it('rejects codes that are not snake_case', () => {
    expect(ToolErrorSchema.safeParse({ ...toolError('ok_code', 'internal', 'x'), code: 'Bad-Code' }).success).toBe(false);
  });
});
