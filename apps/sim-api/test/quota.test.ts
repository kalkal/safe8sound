import { fixedClock } from '@cold-reserve/core';
import { describe, expect, it } from 'vitest';
import { createQuota, memoryQuotaStore, type QuotaLimits } from '../src/quota.js';

const LIMITS: QuotaLimits = { turnsPerCodePerDay: 2, turnsGlobalPerDay: 3, toolCallsPerCodePerDay: 1, failedCodesPerIpPerHour: 2 };
// 2026-10-01 23:59:00 UTC: one minute to the daily reset.
const NOW = Date.UTC(2026, 9, 1, 23, 59, 0);

const quota = (now = NOW, store = memoryQuotaStore()) => createQuota({ store, limits: LIMITS, clock: fixedClock(now) });

describe('daily caps, checked before calling the agent (plan §13.2.4), reset at midnight UTC', () => {
  it('allows turns up to the per-code cap, then answers demo_quota_exceeded with the time to midnight UTC', async () => {
    const q = quota();
    expect((await q.turn('judges')).ok).toBe(true);
    expect((await q.turn('judges')).ok).toBe(true);
    expect(await q.turn('judges')).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded', retryable: true, retryAfterMs: 60_000 } });
  });

  it('enforces the global cap across codes', async () => {
    const q = quota();
    await q.turn('a');
    await q.turn('b');
    await q.turn('c');
    expect(await q.turn('d')).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded' } });
  });

  it('counts card tool calls separately from turns', async () => {
    const q = quota();
    expect((await q.toolCall('judges')).ok).toBe(true);
    expect((await q.toolCall('judges')).ok).toBe(false);
    expect((await q.turn('judges')).ok).toBe(true);
  });

  it('starts again the next UTC day', async () => {
    const store = memoryQuotaStore();
    await quota(NOW, store).turn('judges');
    await quota(NOW, store).turn('judges');
    expect((await quota(NOW + 2 * 60_000, store).turn('judges')).ok).toBe(true);
  });

  it('caps failed demo codes per IP per hour', async () => {
    const q = quota();
    expect(await q.failedCode('203.0.113.7')).toBe(true);
    expect(await q.failedCode('203.0.113.7')).toBe(true);
    expect(await q.failedCode('203.0.113.7')).toBe(false);
    expect(await q.failedCode('198.51.100.1')).toBe(true);
    expect(await q.codeAttemptsLeft('203.0.113.7')).toBe(false);
  });
});
