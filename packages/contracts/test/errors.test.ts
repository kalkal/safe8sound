import { describe, expect, it } from 'vitest';
import {
  ERROR_CATALOG,
  ERROR_CODES,
  ErrorCategorySchema,
  ErrorEnvelopeSchema,
  categoryOf,
  isRetryableCategory,
  toolError,
  type ErrorCode,
} from '../src/index.js';

describe('error catalog (docs/error-handling.md §2)', () => {
  it('lists every code of the error-handling taxonomy', () => {
    const documented: ErrorCode[] = [
      'invalid_setpoint',
      'unknown_room',
      'plan_expired',
      'storm_reserve_violated',
      'inverter_limit_exceeded',
      'pacing_off_track',
      'safe_room_comfort_violated',
      'plan_not_found',
      'home_not_found',
      'missing_token',
      'wrong_client',
      'origin_not_allowed',
      'demo_disabled',
      'plan_already_applied',
      'home_data_stale',
      'split_cloud_unreachable',
      'forecast_unavailable',
      'bedrock_throttled',
      'polly_unavailable',
      'demo_quota_exceeded',
      'unexpected_error',
    ];
    expect(ERROR_CODES).toEqual(expect.arrayContaining(documented));
  });

  it('uses stable snake_case codes and a known category for each', () => {
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(ErrorCategorySchema.safeParse(ERROR_CATALOG[code].category).success).toBe(true);
    }
  });

  it('maps codes to the categories of the taxonomy', () => {
    expect(categoryOf('invalid_setpoint')).toBe('validation');
    expect(categoryOf('storm_reserve_violated')).toBe('guard_rejection');
    // SSM timeout or 5xx at startup: transient, retried (#112).
    expect(categoryOf('config_unavailable')).toBe('dependency_unavailable');
    expect(categoryOf('battery_power_exceeded')).toBe('guard_rejection');
    expect(categoryOf('home_not_found')).toBe('not_found');
    expect(categoryOf('missing_token')).toBe('unauthorized');
    expect(categoryOf('origin_not_allowed')).toBe('forbidden');
    expect(categoryOf('plan_already_applied')).toBe('conflict');
    expect(categoryOf('home_data_stale')).toBe('dependency_unavailable');
    expect(categoryOf('agent_unavailable')).toBe('dependency_unavailable');
    expect(categoryOf('demo_quota_exceeded')).toBe('rate_limited');
    expect(categoryOf('unexpected_error')).toBe('internal');
  });

  it('retries only transient categories', () => {
    const retryable = ErrorCategorySchema.options.filter(isRetryableCategory);
    expect(retryable.sort()).toEqual(['dependency_unavailable', 'rate_limited']);
  });
});

describe('toolError', () => {
  it.each(ERROR_CODES)('produces a valid envelope for %s', (code) => {
    const envelope = toolError(code, 'Short actionable message.');
    expect(ErrorEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.category).toBe(categoryOf(code));
    expect(envelope.retryable).toBe(isRetryableCategory(envelope.category));
  });

  it('carries retryAfterMs and typed details', () => {
    const envelope = toolError('home_data_stale', 'The latest home reading is 20 minutes old.', {
      retryAfterMs: 60_000,
      details: { ageSeconds: 1200 },
    });
    expect(envelope).toEqual({
      code: 'home_data_stale',
      category: 'dependency_unavailable',
      message: 'The latest home reading is 20 minutes old.',
      retryable: true,
      retryAfterMs: 60_000,
      details: { ageSeconds: 1200 },
    });
  });

  it('describes a guard rejection with the guarantee and the nearest allowed value', () => {
    const envelope = toolError('inverter_limit_exceeded', 'Too many splits at once for the inverter.', {
      details: { guarantee: 'inverter_limit', limit: 5000, nearestAllowed: 4800, unit: 'W' },
    });
    expect(ErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});

describe('ErrorEnvelopeSchema', () => {
  const base = { code: 'home_not_found', category: 'not_found', message: 'No such home.', retryable: false };

  it('accepts a consistent envelope', () => {
    expect(ErrorEnvelopeSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an unknown code', () => {
    expect(ErrorEnvelopeSchema.safeParse({ ...base, code: 'something_else' }).success).toBe(false);
  });

  it('rejects a category that does not match the code', () => {
    expect(ErrorEnvelopeSchema.safeParse({ ...base, category: 'internal' }).success).toBe(false);
  });

  it('rejects a retryable flag that does not match the category', () => {
    expect(ErrorEnvelopeSchema.safeParse({ ...base, retryable: true }).success).toBe(false);
  });

  it('allows retryAfterMs only on retryable errors', () => {
    expect(ErrorEnvelopeSchema.safeParse({ ...base, retryAfterMs: 1000 }).success).toBe(false);
  });

  it('rejects an empty or very long message', () => {
    expect(ErrorEnvelopeSchema.safeParse({ ...base, message: '' }).success).toBe(false);
    expect(ErrorEnvelopeSchema.safeParse({ ...base, message: 'x'.repeat(301) }).success).toBe(false);
  });

  it('rejects free-form details (details has a real type)', () => {
    expect(ErrorEnvelopeSchema.safeParse({ ...base, details: { stack: 'at foo()' } }).success).toBe(false);
  });
});
