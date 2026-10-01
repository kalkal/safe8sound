import { err, ok, toolError, type ErrorEnvelope, type HomeId, type Result } from '@cold-reserve/contracts';
import type { Clock } from '@cold-reserve/core';

const DAY_MS = 86_400_000;

export interface Sandboxes<T> {
  /** The sandbox of `home`, created on first use within the daily cap; using it restarts its TTL. */
  admit(home: HomeId): Result<T, ErrorEnvelope>;
  /** The live sandbox of `home`, if any (no creation, no TTL refresh). */
  get(home: HomeId): T | undefined;
}

/**
 * Visitor sandboxes (plan §3.2, approved in #101): created from the demo profile on first use, forgotten
 * `ttlMs` after their last use, and at most `maxNewPerDay` new ones per UTC day, so the cost cannot grow.
 *
 * Everything here lives in one process: on Lambda the cap and the live sandboxes are per warm instance,
 * so the real daily ceiling is `maxNewPerDay` × concurrent instances (10 on a new account). A store-backed
 * counter replaces it if the demo goes public.
 */
export function createSandboxes<T>(opts: { clock: Clock; ttlMs: number; maxNewPerDay: number; create: (home: HomeId) => T }): Sandboxes<T> {
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
  };
}
