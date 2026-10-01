import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import type { Clock } from '@cold-reserve/core';

/** Atomic counters with a cap (DynamoDB `ADD count :1` with `count < :max`, TTL = expiresAtMs, plan §3.2). */
export interface QuotaStore {
  /** Counts one more under `key` if it is below `limit`; false when the cap is reached. */
  consume(key: string, limit: number, expiresAtMs: number): Promise<boolean>;
  /** The current count under `key` (0 when absent). */
  peek(key: string): Promise<number>;
}

/** Local store: keys carry their window (day or hour), so old windows are simply never read again. */
export function memoryQuotaStore(): QuotaStore {
  const counts = new Map<string, number>();
  return {
    consume: (key, limit) => {
      const n = counts.get(key) ?? 0;
      if (n >= limit) return Promise.resolve(false);
      counts.set(key, n + 1);
      return Promise.resolve(true);
    },
    peek: (key) => Promise.resolve(counts.get(key) ?? 0),
  };
}

export interface QuotaLimits {
  readonly turnsPerCodePerDay: number;
  readonly turnsGlobalPerDay: number;
  readonly toolCallsPerCodePerDay: number;
  readonly failedCodesPerIpPerHour: number;
}

export type Quota = ReturnType<typeof createQuota>;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Daily caps reset at midnight UTC (one rule, approved in #101), checked BEFORE calling the agent. */
export function createQuota(deps: { store: QuotaStore; limits: QuotaLimits; clock: Clock }) {
  const { store, limits, clock } = deps;
  const window = (sizeMs: number) => {
    const now = clock.now();
    const start = now - (now % sizeMs);
    return { id: new Date(start).toISOString().slice(0, sizeMs === DAY_MS ? 10 : 13), endMs: start + sizeMs, retryAfterMs: start + sizeMs - now };
  };
  const over = (retryAfterMs: number, message: string): Result<never, ErrorEnvelope> => err(toolError('demo_quota_exceeded', message, { retryAfterMs }));
  const DAILY = 'The demo limit for today is reached. Come back after midnight UTC.';

  return {
    async turn(codeId: string): Promise<Result<void, ErrorEnvelope>> {
      const day = window(DAY_MS);
      if (!(await store.consume(`TURNS#${codeId}#${day.id}`, limits.turnsPerCodePerDay, day.endMs))) return over(day.retryAfterMs, DAILY);
      if (!(await store.consume(`TURNS#GLOBAL#${day.id}`, limits.turnsGlobalPerDay, day.endMs))) return over(day.retryAfterMs, DAILY);
      return ok(undefined);
    },
    async toolCall(codeId: string): Promise<Result<void, ErrorEnvelope>> {
      const day = window(DAY_MS);
      return (await store.consume(`TOOLS#${codeId}#${day.id}`, limits.toolCallsPerCodePerDay, day.endMs)) ? ok(undefined) : over(day.retryAfterMs, DAILY);
    },
    /** Records a wrong demo code from this IP; false once the hourly cap is reached. */
    failedCode(ip: string): Promise<boolean> {
      const hour = window(HOUR_MS);
      return store.consume(`FAIL#${ip}#${hour.id}`, limits.failedCodesPerIpPerHour, hour.endMs);
    },
    /** Whether this IP may still try a code: checked before looking at the code at all. */
    async codeAttemptsLeft(ip: string): Promise<boolean> {
      return (await store.peek(`FAIL#${ip}#${window(HOUR_MS).id}`)) < limits.failedCodesPerIpPerHour;
    },
    tooManyAttempts: (): Result<never, ErrorEnvelope> => over(window(HOUR_MS).retryAfterMs, 'Too many wrong demo codes. Try again in an hour.'),
  };
}
