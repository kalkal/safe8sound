import { err, ok, toolError, type ErrorEnvelope, type HomeId, type Result } from '@cold-reserve/contracts';
import type { Clock } from '@cold-reserve/core';

const DAY_MS = 86_400_000;

export interface Sandboxes<T, S = unknown> {
  /** The sandbox of `home`, created on first use within the daily cap; using it restarts its TTL. */
  admit(home: HomeId): Result<T, ErrorEnvelope>;
  /** The live sandbox of `home`, if any (no creation, no TTL refresh). */
  get(home: HomeId): T | undefined;
  /**
   * Brings a live sandbox up to date with its stored settings (C2, #222): the handler awaits it right after
   * `admit`, so every container sees a change at its next request. It never throws: a failure keeps the sandbox.
   * `saved`: the settings this request has just stored, played with no read (#406).
   */
  refresh(home: HomeId, correlationId: string, saved?: S): Promise<void>;
}

/**
 * Visitor sandboxes (plan §3.2, approved in #101): created from the demo profile on first use, forgotten
 * `ttlMs` after their last use, and at most `maxNewPerDay` new ones per UTC day, so the cost cannot grow.
 *
 * Everything here lives in one process: on Lambda the cap and the live sandboxes are per warm instance,
 * so the real daily ceiling is `maxNewPerDay` × concurrent instances (10 on a new account). A store-backed
 * counter replaces it if the demo goes public.
 */
export function createSandboxes<T, S = unknown>(opts: {
  clock: Clock;
  ttlMs: number;
  maxNewPerDay: number;
  create: (home: HomeId) => T;
  /** Returns the sandbox to keep: the same one, or one rebuilt from new settings. It handles its own failures. */
  refresh?: (home: HomeId, current: T, correlationId: string, saved?: S) => Promise<T>;
}): Sandboxes<T, S> {
  const live = new Map<HomeId, { value: T; lastUsedMs: number }>();
  let day = -1;
  let createdToday = 0;

  const sweep = (now: number) => {
    for (const [home, entry] of live) if (now - entry.lastUsedMs > opts.ttlMs) live.delete(home);
  };

  return {
    admit(home) {
      const now = opts.clock.now();
      sweep(now);
      const existing = live.get(home);
      if (existing) {
        existing.lastUsedMs = now;
        return ok(existing.value);
      }
      const today = Math.floor(now / DAY_MS);
      if (today !== day) {
        day = today;
        createdToday = 0;
      }
      if (createdToday >= opts.maxNewPerDay) {
        return err(toolError('demo_quota_exceeded', 'The demo is full for today. Come back after midnight UTC.', { retryAfterMs: (today + 1) * DAY_MS - now }));
      }
      createdToday++;
      const value = opts.create(home);
      live.set(home, { value, lastUsedMs: now });
      return ok(value);
    },
    get(home) {
      sweep(opts.clock.now());
      return live.get(home)?.value;
    },
    async refresh(home, correlationId, saved) {
      const entry = live.get(home);
      if (entry === undefined || opts.refresh === undefined) return;
      const next = await opts.refresh(home, entry.value, correlationId, saved);
      // Another request may have replaced or forgotten it meanwhile: only the entry we read is updated.
      if (live.get(home) === entry) entry.value = next;
    },
  };
}
