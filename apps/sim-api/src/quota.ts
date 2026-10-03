import { createHmac } from 'node:crypto';
import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import type { Clock } from '@cold-reserve/core';

/** Atomic counters with a cap (DynamoDB `ADD count :1` with `count < :max`, TTL = expiresAtMs, plan §3.2). */
export interface QuotaStore {
  /** Counts one more under `key` if it is below `limit`; false when the cap is reached. */
  /** Adds `amount` (1 by default) under `key` if it still fits under `limit`; false when the cap is reached. */
  consume(key: string, limit: number, expiresAtMs: number, amount?: number): Promise<boolean>;
  /** Gives one count back under `key` (a right demo code); nothing when there is nothing to give back. */
  release(key: string): Promise<void>;
}

/** Local store: keys carry their window (day or hour), so old windows are simply never read again. */
export function memoryQuotaStore(): QuotaStore {
  const counts = new Map<string, number>();
  return {
    consume: (key, limit, _expiresAtMs, amount = 1) => {
      const n = counts.get(key) ?? 0;
      if (n + amount > limit) return Promise.resolve(false);
      counts.set(key, n + amount);
      return Promise.resolve(true);
    },
    release: (key) => {
      const n = counts.get(key) ?? 0;
      if (n > 0) counts.set(key, n - 1);
      return Promise.resolve();
    },
  };
}

export interface QuotaLimits {
  readonly turnsPerCodePerDay: number;
  readonly turnsGlobalPerDay: number;
  readonly toolCallsPerCodePerDay: number;
  /** Wrong demo codes per client IP per hour (a right code gives its attempt back, review of #139). */
  readonly codeAttemptsPerIpPerHour: number;
  /** Characters spoken by Polly per demo code and overall per UTC day; cache hits are free (approved in #25). */
  readonly speechCharsPerCodePerDay: number;
  readonly speechCharsGlobalPerDay: number;
}

export type Quota = ReturnType<typeof createQuota>;

/** Store failures a retry may fix: throttling, an AWS server fault (5xx), an SDK timeout, the network. */
const TRANSIENT_NAMES: ReadonlySet<string> = new Set(['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded', 'InternalServerError', 'ServiceUnavailable', 'TimeoutError']);
const NETWORK_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);
const isTransient = (e: unknown): e is Error => {
  if (!(e instanceof Error)) return false;
  const { $fault, $metadata, code } = e as { $fault?: unknown; $metadata?: { httpStatusCode?: unknown }; code?: unknown };
  const status = $metadata?.httpStatusCode;
  return TRANSIENT_NAMES.has(e.name) || $fault === 'server' || (typeof status === 'number' && status >= 500) || NETWORK_CODES.has(String(code));
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Daily caps reset at midnight UTC (one rule, approved in #101), checked BEFORE calling the agent. */
export function createQuota(deps: { store: QuotaStore; limits: QuotaLimits; clock: Clock; ipSalt: Uint8Array }) {
  const { store, limits, clock } = deps;
  // The client IP is personal data: the table (with 35 days of PITR) holds only a salted hash of it.
  const ipKey = (ip: string) => createHmac('sha256', deps.ipSalt).update(ip).digest('hex').slice(0, 32);
  const window = (sizeMs: number) => {
    const now = clock.now();
    const start = now - (now % sizeMs);
    return { id: new Date(start).toISOString().slice(0, sizeMs === DAY_MS ? 10 : 13), endMs: start + sizeMs, retryAfterMs: start + sizeMs - now };
  };
  const over = (retryAfterMs: number, message: string): Result<never, ErrorEnvelope> => err(toolError('demo_quota_exceeded', message, { retryAfterMs }));
  const DAILY = 'The demo limit for today is reached. Come back after midnight UTC.';
  const SPOKEN = 'The spoken replies for today are used up; the answers still come as text.';
  /**
   * A transient store failure is a retryable 503 `store_unavailable` (Copilot on #156), still fail closed:
   * nothing goes on without the count. Its error name goes to the log; anything else (a bug of ours, a
   * client fault) is rethrown for the last resort (500).
   */
  // The cause name of a store failure, for the log line only (it never reaches the answer).
  const causes = new WeakMap<ErrorEnvelope, string>();
  const counted = async <T>(run: () => Promise<T>): Promise<Result<T, ErrorEnvelope>> => {
    try {
      return ok(await run());
    } catch (e) {
      if (!isTransient(e)) throw e;
      const error = toolError('store_unavailable', 'The demo cannot count its limits right now. Try again in a moment.');
      causes.set(error, e.name);
      return err(error);
    }
  };

  return {
    async turn(codeId: string): Promise<Result<void, ErrorEnvelope>> {
      const day = window(DAY_MS);
      const perCode = await counted(() => store.consume(`TURNS#${codeId}#${day.id}`, limits.turnsPerCodePerDay, day.endMs));
      if (!perCode.ok) return perCode;
      if (!perCode.value) return over(day.retryAfterMs, DAILY);
      const overall = await counted(() => store.consume(`TURNS#GLOBAL#${day.id}`, limits.turnsGlobalPerDay, day.endMs));
      if (!overall.ok) return overall;
      return overall.value ? ok(undefined) : over(day.retryAfterMs, DAILY);
    },
    /** The characters of one reply Polly is about to speak: per code, then overall (F8d, #25). */
    async speech(codeId: string, chars: number): Promise<Result<void, ErrorEnvelope>> {
      const day = window(DAY_MS);
      const perCode = await counted(() => store.consume(`SPEECH#${codeId}#${day.id}`, limits.speechCharsPerCodePerDay, day.endMs, chars));
      if (!perCode.ok) return perCode;
      if (!perCode.value) return over(day.retryAfterMs, SPOKEN);
      const overall = await counted(() => store.consume(`SPEECH#GLOBAL#${day.id}`, limits.speechCharsGlobalPerDay, day.endMs, chars));
      if (!overall.ok) return overall;
      return overall.value ? ok(undefined) : over(day.retryAfterMs, SPOKEN);
    },
    async toolCall(codeId: string): Promise<Result<void, ErrorEnvelope>> {
      const day = window(DAY_MS);
      const allowed = await counted(() => store.consume(`TOOLS#${codeId}#${day.id}`, limits.toolCallsPerCodePerDay, day.endMs));
      if (!allowed.ok) return allowed;
      return allowed.value ? ok(undefined) : over(day.retryAfterMs, DAILY);
    },
    /**
     * Counts one demo code attempt from this IP, atomically, BEFORE the code is looked at (review of #110):
     * past the hourly cap even a right code is refused, so guessing cannot go on. A right code then gives its
     * attempt back (`release`), so only wrong codes stay counted (review of #139).
     */
    async codeAttempt(ip: string): Promise<Result<{ allowed: boolean; release: () => Promise<void> }, ErrorEnvelope>> {
      const hour = window(HOUR_MS);
      const key = `ATTEMPT#${ipKey(ip)}#${hour.id}`;
      const allowed = await counted(() => store.consume(key, limits.codeAttemptsPerIpPerHour, hour.endMs));
      return allowed.ok ? ok({ allowed: allowed.value, release: () => store.release(key) }) : allowed;
    },
    /** The store error name behind a `store_unavailable` this quota answered, for the log. */
    causeOf: (error: ErrorEnvelope): string | undefined => causes.get(error),
    tooManyAttempts: (): ErrorEnvelope => toolError('demo_quota_exceeded', 'Too many demo code attempts. Try again in an hour.', { retryAfterMs: window(HOUR_MS).retryAfterMs }),
  };
}
