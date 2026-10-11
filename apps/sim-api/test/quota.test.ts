import { fixedClock } from '@cold-reserve/core';
import { describe, expect, it } from 'vitest';
import { createQuota, memoryQuotaStore, type QuotaLimits, type QuotaStore } from '../src/quota.js';

const LIMITS: QuotaLimits = { turnsPerCodePerDay: 2, turnsGlobalPerDay: 3, toolCallsPerCodePerDay: 1, readCallsPerCodePerDay: 2, readCallsGlobalPerDay: 3, codeAttemptsPerIpPerHour: 2, speechCharsPerCodePerDay: 6000, speechCharsGlobalPerDay: 30_000, phoneReadsPerSessionPerMinute: 2, phoneReadsPerCodePerMinute: 3 };
// 2026-10-01 23:59:00 UTC: one minute to the daily reset.
const NOW = Date.UTC(2026, 9, 1, 23, 59, 0);

const SALT = Buffer.alloc(32, 5);
const allowedOf = async (q: ReturnType<typeof createQuota>, ip: string) => {
  const attempt = await q.codeAttempt(ip);
  if (!attempt.ok) throw new Error('store failed');
  return attempt.value.allowed;
};
const quota = (now = NOW, store = memoryQuotaStore()) => createQuota({ store, limits: LIMITS, clock: fixedClock(now), ipSalt: SALT });

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
    expect((await q.toolCall('judges', 'write')).ok).toBe(true);
    expect((await q.toolCall('judges', 'write')).ok).toBe(false);
    expect((await q.turn('judges')).ok).toBe(true);
  });

  it('#334: card reads have their own count: they never use up the writes, and their cap answers the same 429', async () => {
    const q = quota();
    expect((await q.toolCall('judges', 'read')).ok).toBe(true);
    expect((await q.toolCall('judges', 'read')).ok).toBe(true);
    expect(await q.toolCall('judges', 'read')).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded', retryable: true, retryAfterMs: 60_000 } });
    expect((await q.toolCall('judges', 'write')).ok).toBe(true);
  });

  it('#334: the overall read cap holds across codes, and a refused read gives its per-code count back', async () => {
    const store = memoryQuotaStore();
    const q = quota(NOW, store);
    await q.toolCall('a', 'read');
    await q.toolCall('b', 'read');
    await q.toolCall('c', 'read');
    expect(await q.toolCall('c', 'read')).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded' } });
    // c used one read and the refused one went back: with room again overall, c still has its second read.
    await store.release(`READS#GLOBAL#2026-10-01`);
    expect((await q.toolCall('c', 'read')).ok).toBe(true);
  });

  it('starts again the next UTC day', async () => {
    const store = memoryQuotaStore();
    await quota(NOW, store).turn('judges');
    await quota(NOW, store).turn('judges');
    expect((await quota(NOW + 2 * 60_000, store).turn('judges')).ok).toBe(true);
  });

  it('caps demo code attempts per IP per hour, counted atomically before the code is looked at (review of #110)', async () => {
    const q = quota();
    expect(await allowedOf(q, '203.0.113.7')).toBe(true);
    expect(await allowedOf(q, '203.0.113.7')).toBe(true);
    expect(await allowedOf(q, '203.0.113.7')).toBe(false);
    expect(await allowedOf(q, '198.51.100.1')).toBe(true);
  });

  it('lets no more than the cap through when attempts arrive at the same time', async () => {
    const q = quota();
    const results = await Promise.all(Array.from({ length: 6 }, () => q.codeAttempt('203.0.113.7')));
    expect(results.filter((r) => r.ok && r.value.allowed)).toHaveLength(2);
  });

  it('gives a right code its attempt back, so only wrong codes count toward the cap (review of #139)', async () => {
    const q = quota();
    for (let i = 0; i < 5; i++) {
      const attempt = await q.codeAttempt('203.0.113.7');
      if (!attempt.ok) throw new Error('store failed');
      expect(attempt.value.allowed).toBe(true);
      await attempt.value.release();
    }
    expect(await allowedOf(q, '203.0.113.7')).toBe(true);
    expect(await allowedOf(q, '203.0.113.7')).toBe(true);
    expect(await allowedOf(q, '203.0.113.7')).toBe(false);
  });

  it('never keeps the client IP in clear: the key holds a salted hash of it (personal data, PITR keeps 35 days)', async () => {
    const keys: string[] = [];
    const inner = memoryQuotaStore();
    const store: QuotaStore = {
      consume: (key, limit, expiresAtMs) => {
        keys.push(key);
        return inner.consume(key, limit, expiresAtMs);
      },
      release: (key) => inner.release(key),
    };
    await quota(NOW, store).codeAttempt('203.0.113.7');
    await createQuota({ store, limits: LIMITS, clock: fixedClock(NOW), ipSalt: Buffer.alloc(32, 6) }).codeAttempt('203.0.113.7');
    expect(keys.join()).not.toContain('203.0.113.7');
    expect(keys[0]).toMatch(/^ATTEMPT#[0-9a-f]{32}#2026-10-01T23$/);
    expect(keys[1]).not.toBe(keys[0]); // another salt, another key: the hash cannot be looked up without the salt
  });
});

describe('a slow or failing quota store (Copilot on #156)', () => {
  const failing = (error: Error): QuotaStore => ({ consume: () => Promise.reject(error), release: () => Promise.reject(error) });
  const named = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error('x'), { name, ...extra });

  it.each([
    ['DynamoDB throttling', named('ProvisionedThroughputExceededException')],
    ['request throttling', named('ThrottlingException')],
    ['an AWS server fault', named('InternalServerError', { $fault: 'server' })],
    ['a 503', named('ServiceUnavailable', { $metadata: { httpStatusCode: 503 } })],
    ['an SDK timeout', named('TimeoutError')],
    ['a network failure', Object.assign(new Error('connect'), { code: 'ECONNRESET' })],
  ])('answers store_unavailable (503, retryable, still fail closed) for %s, keeping the error name', async (_case, error) => {
    const q = createQuota({ store: failing(error), limits: LIMITS, clock: fixedClock(NOW), ipSalt: SALT });
    for (const result of [await q.turn('judges'), await q.toolCall('judges', 'write'), await q.codeAttempt('203.0.113.7')]) {
      expect(result).toMatchObject({ ok: false, error: { code: 'store_unavailable', category: 'dependency_unavailable', retryable: true } });
      if (!result.ok) expect(q.causeOf(result.error)).toBe(error.name);
    }
  });

  it('lets a bug of ours through (a RangeError, a client fault): the last resort answers 500', async () => {
    for (const error of [new RangeError('bug'), named('ValidationException', { $fault: 'client' })]) {
      const q = createQuota({ store: failing(error), limits: LIMITS, clock: fixedClock(NOW), ipSalt: SALT });
      await expect(q.turn('judges')).rejects.toBe(error);
      await expect(q.codeAttempt('203.0.113.7')).rejects.toBe(error);
    }
  });
});

describe('speech characters (F8d, #25, approved in #25): per code and overall per UTC day', () => {
  const SPEECH: QuotaLimits = { ...LIMITS, speechCharsPerCodePerDay: 100, speechCharsGlobalPerDay: 150 };
  const q = (store = memoryQuotaStore()) => createQuota({ store, limits: SPEECH, clock: fixedClock(NOW), ipSalt: SALT });

  it('counts the characters of each spoken reply, up to the per-code cap', async () => {
    const quota = q();
    expect((await quota.speech('judges', 60)).ok).toBe(true);
    expect((await quota.speech('judges', 40)).ok).toBe(true);
    expect(await quota.speech('judges', 1)).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded', retryAfterMs: 60_000 } });
  });

  it('gives the per-code count back when the overall cap refuses, so a refusal never uses up the code (review of #195)', async () => {
    const store = memoryQuotaStore();
    const quota = q(store);
    expect((await quota.speech('a', 100)).ok).toBe(true);
    expect((await quota.speech('b', 50)).ok).toBe(true);
    expect((await quota.speech('c', 60)).ok).toBe(false); // overall: 150 + 60 > 150
    // Same counters, a larger overall cap: c still has its whole per-code room (100) only if the 60 came back.
    const roomier = createQuota({ store, limits: { ...SPEECH, speechCharsGlobalPerDay: 1000 }, clock: fixedClock(NOW), ipSalt: SALT });
    expect((await roomier.speech('c', 100)).ok).toBe(true);
  });

  it('enforces the overall cap across codes', async () => {
    const quota = q();
    expect((await quota.speech('a', 100)).ok).toBe(true);
    expect((await quota.speech('b', 50)).ok).toBe(true);
    expect((await quota.speech('c', 1)).ok).toBe(false);
  });
});

describe('a failed give-back after the overall speech cap refused (review of #195)', () => {
  it('still answers the refusal, and reports the error name so the handler can log it', async () => {
    const inner = memoryQuotaStore();
    const store: QuotaStore = {
      consume: (k, l, e, a) => inner.consume(k, l, e, a),
      release: () => Promise.reject(Object.assign(new Error('slow'), { name: 'ThrottlingException' })),
    };
    const limits: QuotaLimits = { ...LIMITS, speechCharsPerCodePerDay: 100, speechCharsGlobalPerDay: 50 };
    const quota = createQuota({ store, limits, clock: fixedClock(NOW), ipSalt: SALT });
    const failed: string[] = [];
    expect(await quota.speech('c', 60, (name) => failed.push(name))).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded' } });
    expect(failed).toEqual(['ThrottlingException']);
  });
});


describe('phone reads per session and per code per minute (#294)', () => {
  it('lets a session poll up to its cap within the minute, then 429 with the wait to the next minute', async () => {
    const q = quota(Date.UTC(2026, 9, 8, 18, 30, 15));
    expect((await q.phoneRead('judges', 'tab-1')).ok).toBe(true);
    expect((await q.phoneRead('judges', 'tab-1')).ok).toBe(true);
    expect(await q.phoneRead('judges', 'tab-1')).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded', category: 'rate_limited', retryAfterMs: 45_000 } });
    // Another session on the same code has its own count (the judges may share one code).
    expect((await q.phoneRead('judges', 'tab-2')).ok).toBe(true);
  });

  it('caps the reads of all the sessions of one code together; another code has its own count', async () => {
    const q = quota(Date.UTC(2026, 9, 8, 18, 30, 15));
    expect((await q.phoneRead('judges', 'tab-1')).ok).toBe(true);
    expect((await q.phoneRead('judges', 'tab-2')).ok).toBe(true);
    expect((await q.phoneRead('judges', 'tab-3')).ok).toBe(true);
    expect(await q.phoneRead('judges', 'tab-4')).toMatchObject({ ok: false, error: { code: 'demo_quota_exceeded', retryAfterMs: 45_000 } });
    expect((await q.phoneRead('other', 'tab-5')).ok).toBe(true);
  });

  it("a read the session cap refuses does not use up the code's count", async () => {
    const q = quota(Date.UTC(2026, 9, 8, 18, 30, 15));
    // 2 reads counted, 3 refused by the session cap: the code (cap 3) still has exactly one read left.
    for (let i = 0; i < 5; i++) await q.phoneRead('judges', 'runaway');
    expect((await q.phoneRead('judges', 'tab-1')).ok).toBe(true);
    expect((await q.phoneRead('judges', 'tab-2')).ok).toBe(false);
  });

  it('a new minute starts a new count', async () => {
    const store = memoryQuotaStore();
    const first = quota(Date.UTC(2026, 9, 8, 18, 30, 59), store);
    await first.phoneRead('judges', 'tab-1');
    await first.phoneRead('judges', 'tab-1');
    expect((await quota(Date.UTC(2026, 9, 8, 18, 31, 0), store).phoneRead('judges', 'tab-1')).ok).toBe(true);
  });
});
