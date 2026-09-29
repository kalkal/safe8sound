import {
  DATA_GROUPS,
  epochMs,
  err,
  minutes,
  ok,
  toolError,
  type ErrorCode,
  type ErrorEnvelope,
  type HomeLink,
  type Minutes,
  type Result,
  type Snapshot,
} from '@cold-reserve/contracts';
import { resolveOrigin, type Clock, type HomeDataSource } from '@cold-reserve/core';

// Strategy + Decorator (plan §1 principle 3, §9.2): the real home first, the simulator when the
// real data is older than `maxStaleness` or missing, and the switch is always declared:
// homeLink (ok | stale | lost), lastLiveAt, the HOME_UNREACHABLE event, and an origin that is
// never "live" for fallback data.

export type SourceEvent =
  | {
      readonly type: 'HOME_UNREACHABLE';
      readonly at: string;
      readonly homeLink: Exclude<HomeLink, 'ok'>;
      readonly lastLiveAt?: string;
      /** Why the primary was not used. */
      readonly reason: ErrorCode;
    }
  | { readonly type: 'HOME_REACHABLE'; readonly at: string };

export interface FallbackSourceOptions {
  readonly primary: HomeDataSource;
  readonly fallback: HomeDataSource;
  readonly clock: Clock;
  /** From config; the plan's default is 15 minutes. A reading exactly this old is still fresh. */
  readonly maxStaleness?: Minutes;
  /** Explicit timeout on the primary (docs/error-handling.md §4). */
  readonly primaryTimeoutMs?: number;
  readonly onEvent?: (event: SourceEvent) => void;
}

const DEFAULT_MAX_STALENESS = minutes(15);
const DEFAULT_PRIMARY_TIMEOUT_MS = 2_000;

type PrimaryOutcome = { readonly ok: true; readonly snapshot: Snapshot } | { readonly ok: false; readonly reason: ErrorCode };

export class FallbackSource implements HomeDataSource {
  readonly #opts: FallbackSourceOptions;
  #lastLiveAt: string | undefined;
  #link: HomeLink | undefined;

  constructor(opts: FallbackSourceOptions) {
    this.#opts = opts;
  }

  async snapshot(): Promise<Result<Snapshot, ErrorEnvelope>> {
    const nowMs = this.#opts.clock.now();
    const at = new Date(nowMs).toISOString();
    const maxAgeMs = (this.#opts.maxStaleness ?? DEFAULT_MAX_STALENESS) * 60_000;

    const primary = await this.#readPrimary();
    if (primary.ok) {
      this.#lastLiveAt = primary.snapshot.ts;
      if (nowMs - epochMs(primary.snapshot.ts) <= maxAgeMs) {
        if (this.#link !== undefined && this.#link !== 'ok') this.#emit({ type: 'HOME_REACHABLE', at });
        this.#link = 'ok';
        return ok({ ...primary.snapshot, homeLink: 'ok' });
      }
    }

    const link: Exclude<HomeLink, 'ok'> = primary.ok ? 'stale' : 'lost';
    const reason: ErrorCode = primary.ok ? 'home_data_stale' : primary.reason;
    const lastLiveAt = this.#lastLiveAt;
    if (this.#link === undefined || this.#link === 'ok') {
      this.#emit({ type: 'HOME_UNREACHABLE', at, homeLink: link, ...(lastLiveAt === undefined ? {} : { lastLiveAt }), reason });
    }
    this.#link = link;

    const fallback = await this.#readFallback();
    if (!fallback.ok) {
      const ageSeconds = lastLiveAt === undefined ? undefined : Math.max(0, Math.round((nowMs - epochMs(lastLiveAt)) / 1000));
      return err(
        toolError('home_data_stale', 'Home data is not available and the simulator failed; try again shortly.', {
          ...(ageSeconds === undefined ? {} : { details: { ageSeconds } }),
        }),
      );
    }

    // Fallback data is never shown as live, whatever the fallback says about itself.
    const scenario = fallback.value.origin.scenario;
    return ok({
      ...fallback.value,
      origin: resolveOrigin([], scenario === undefined ? undefined : { id: scenario, simulatedGroups: DATA_GROUPS }),
      homeLink: link,
      ...(lastLiveAt === undefined ? {} : { lastLiveAt }),
    });
  }

  async #readPrimary(): Promise<PrimaryOutcome> {
    const timeoutMs = this.#opts.primaryTimeoutMs ?? DEFAULT_PRIMARY_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<PrimaryOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({ ok: false, reason: 'home_data_stale' });
      }, timeoutMs);
    });
    const read = this.#opts.primary.snapshot().then(
      (r): PrimaryOutcome => (r.ok ? { ok: true, snapshot: r.value } : { ok: false, reason: r.error.code }),
      // A throwing source is a bug: handled here by the fallback and reported through the event.
      (): PrimaryOutcome => ({ ok: false, reason: 'unexpected_error' }),
    );
    try {
      return await Promise.race([read, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #readFallback(): Promise<Result<Snapshot, ErrorEnvelope>> {
    try {
      return await this.#opts.fallback.snapshot();
    } catch {
      return err(toolError('unexpected_error', 'The simulator failed.'));
    }
  }

  #emit(event: SourceEvent): void {
    this.#opts.onEvent?.(event);
  }
}
