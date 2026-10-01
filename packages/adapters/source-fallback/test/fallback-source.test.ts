import { SnapshotSchema, err, minutes, ok, toolError, type ErrorEnvelope, type Result, type Snapshot } from '@cold-reserve/contracts';
import { exampleSnapshot } from '@cold-reserve/contracts/fixtures';
import type { HomeDataSource } from '@cold-reserve/core';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FallbackSource, type SourceEvent } from '../src/fallback-source.js';

const T0 = Date.parse('2026-07-15T14:00:00+02:00');
const MIN = 60_000;

const liveSnapshot = (tsMs: number): Snapshot =>
  SnapshotSchema.parse({
    ...exampleSnapshot(),
    homeId: 'home',
    ts: new Date(tsMs).toISOString(),
    origin: { energy: 'live', rooms: 'live', weather: 'live' },
  });

const simSnapshot = (tsMs: number, scenario?: string): Snapshot =>
  SnapshotSchema.parse({
    ...exampleSnapshot(),
    homeId: 'home',
    ts: new Date(tsMs).toISOString(),
    origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated', ...(scenario === undefined ? {} : { scenario }) },
  });

const sourceOf = (fn: () => Promise<Result<Snapshot, ErrorEnvelope>>): HomeDataSource & { calls: number } => {
  const s = {
    calls: 0,
    snapshot: () => {
      s.calls++;
      return fn();
    },
  };
  return s;
};

const setup = (opts: { primary: HomeDataSource; fallback?: HomeDataSource & { calls: number }; now?: () => number; maxStaleness?: number; timeoutMs?: number }) => {
  const events: SourceEvent[] = [];
  const fallback = opts.fallback ?? sourceOf(() => Promise.resolve(ok(simSnapshot(T0, 'clear-day'))));
  const fb = new FallbackSource({
    primary: opts.primary,
    fallback,
    clock: { now: opts.now ?? (() => T0) },
    ...(opts.maxStaleness === undefined ? {} : { maxStaleness: minutes(opts.maxStaleness) }),
    ...(opts.timeoutMs === undefined ? {} : { primaryTimeoutMs: opts.timeoutMs }),
    onEvent: (e) => events.push(e),
  });
  return { fb, events, fallback };
};

const value = async (fb: FallbackSource): Promise<Snapshot> => {
  const r = await fb.snapshot();
  if (!r.ok) throw new Error(`expected a snapshot, got ${r.error.code}`);
  return r.value;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('FallbackSource', () => {
  it('passes a fresh primary snapshot through, live, without calling the fallback', async () => {
    const primary = sourceOf(() => Promise.resolve(ok(liveSnapshot(T0 - 2 * MIN))));
    const { fb, fallback } = setup({ primary });
    const s = await value(fb);
    expect(s.origin).toEqual({ energy: 'live', rooms: 'live', weather: 'live' });
    expect(s.homeLink).toBe('ok');
    expect(fallback.calls).toBe(0);
  });

  it('switches to the simulator when the primary is older than 15 minutes, and says so', async () => {
    const lastLive = T0 - 16 * MIN;
    const primary = sourceOf(() => Promise.resolve(ok(liveSnapshot(lastLive))));
    const { fb, events } = setup({ primary });
    const s = await value(fb);
    expect(s.origin).toEqual({ energy: 'simulated', rooms: 'simulated', weather: 'simulated', scenario: 'clear-day' });
    expect(s.homeLink).toBe('stale');
    expect(s.lastLiveAt).toBe(new Date(lastLive).toISOString());
    expect(SnapshotSchema.safeParse(s).success).toBe(true);
    expect(events).toEqual([{ type: 'HOME_UNREACHABLE', at: new Date(T0).toISOString(), homeLink: 'stale', lastLiveAt: new Date(lastLive).toISOString(), reason: 'home_data_stale' }]);
  });

  it('property: staleness switches the origin exactly at 15 minutes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 30 * MIN }), async (ageMs) => {
        const primary = sourceOf(() => Promise.resolve(ok(liveSnapshot(T0 - ageMs))));
        const s = await value(setup({ primary }).fb);
        const fresh = ageMs <= 15 * MIN;
        expect(s.homeLink).toBe(fresh ? 'ok' : 'stale');
        expect(s.origin.energy).toBe(fresh ? 'live' : 'simulated');
      }),
    );
  });

  it('uses the configured staleness threshold', async () => {
    const primary = sourceOf(() => Promise.resolve(ok(liveSnapshot(T0 - 6 * MIN))));
    expect((await value(setup({ primary, maxStaleness: 5 }).fb)).homeLink).toBe('stale');
    expect((await value(setup({ primary, maxStaleness: 10 }).fb)).homeLink).toBe('ok');
  });

  it('marks the link lost when the primary fails, and remembers the last live reading', async () => {
    let fail = false;
    const primary = sourceOf(() => Promise.resolve(fail ? err(toolError('home_data_stale', 'No data.')) : ok(liveSnapshot(T0 - MIN))));
    const { fb, events } = setup({ primary });
    await value(fb);
    fail = true;
    const s = await value(fb);
    expect(s.homeLink).toBe('lost');
    expect(s.lastLiveAt).toBe(new Date(T0 - MIN).toISOString());
    expect(events).toEqual([{ type: 'HOME_UNREACHABLE', at: new Date(T0).toISOString(), homeLink: 'lost', lastLiveAt: new Date(T0 - MIN).toISOString(), reason: 'home_data_stale' }]);
  });

  it('has no lastLiveAt when the home was never reached', async () => {
    const primary = sourceOf(() => Promise.resolve(err(toolError('home_not_found', 'Unknown home.'))));
    const s = await value(setup({ primary }).fb);
    expect(s.homeLink).toBe('lost');
    expect(s).not.toHaveProperty('lastLiveAt');
  });

  it('treats a primary that throws as lost and reports it (a bug, never swallowed)', async () => {
    const primary = sourceOf(() => Promise.reject(new Error('boom')));
    const { fb, events } = setup({ primary });
    const s = await value(fb);
    expect(s.homeLink).toBe('lost');
    expect(events[0]).toMatchObject({ type: 'HOME_UNREACHABLE', homeLink: 'lost', reason: 'unexpected_error', errorName: 'Error' });
  });

  it('keeps the name of what the primary threw, never its text (#113)', async () => {
    const primary = sourceOf(() => Promise.reject(new TypeError('cannot read secret-token of undefined')));
    const { fb, events } = setup({ primary });
    await value(fb);
    expect(events[0]).toMatchObject({ errorName: 'TypeError' });
    expect(JSON.stringify(events)).not.toContain('secret-token');
  });

  it('times out a primary that hangs and falls back', async () => {
    vi.useFakeTimers();
    const primary = sourceOf(() => new Promise(() => undefined));
    const { fb, events } = setup({ primary, timeoutMs: 2_000 });
    const pending = fb.snapshot();
    await vi.advanceTimersByTimeAsync(2_000);
    const r = await pending;
    expect(r.ok && r.value.homeLink).toBe('lost');
    expect(events[0]).toMatchObject({ reason: 'home_data_stale' });
  });

  it('announces the way back once', async () => {
    let now = T0;
    let tsMs = T0 - 20 * MIN;
    const primary = sourceOf(() => Promise.resolve(ok(liveSnapshot(tsMs))));
    const { fb, events } = setup({ primary, now: () => now });
    await value(fb);
    await value(fb);
    tsMs = T0;
    now = T0 + MIN;
    expect((await value(fb)).homeLink).toBe('ok');
    await value(fb);
    expect(events.map((e) => e.type)).toEqual(['HOME_UNREACHABLE', 'HOME_REACHABLE']);
    expect(events[1]).toEqual({ type: 'HOME_REACHABLE', at: new Date(T0 + MIN).toISOString() });
  });

  it('keeps the fallback scenario name only when the fallback has one', async () => {
    const primary = sourceOf(() => Promise.resolve(err(toolError('home_data_stale', 'No data.'))));
    const fallback = sourceOf(() => Promise.resolve(ok(simSnapshot(T0))));
    const s = await value(setup({ primary, fallback }).fb);
    expect(s.origin).toEqual({ energy: 'simulated', rooms: 'simulated', weather: 'simulated' });
  });

  it('never presents fallback data as live, even if the fallback claims so', async () => {
    const primary = sourceOf(() => Promise.resolve(err(toolError('home_data_stale', 'No data.'))));
    const fallback = sourceOf(() => Promise.resolve(ok(liveSnapshot(T0))));
    const s = await value(setup({ primary, fallback }).fb);
    expect(s.origin).toEqual({ energy: 'simulated', rooms: 'simulated', weather: 'simulated' });
  });

  it('returns home_data_stale (retryable) when both sources are down for a reason a retry can fix', async () => {
    const primary = sourceOf(() => Promise.resolve(ok(liveSnapshot(T0 - 40 * MIN))));
    const fallback = sourceOf(() => Promise.resolve(err(toolError('store_unavailable', 'The fallback store did not answer.'))));
    const r = await setup({ primary, fallback }).fb.snapshot();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: 'home_data_stale', category: 'dependency_unavailable', retryable: true, details: { ageSeconds: 40 * 60 } });
  });

  it('returns home_data_stale without an age when the home was never reached', async () => {
    const primary = sourceOf(() => Promise.resolve(err(toolError('home_not_found', 'Unknown home.'))));
    const fallback = sourceOf(() => Promise.resolve(err(toolError('store_unavailable', 'Down.'))));
    const r = await setup({ primary, fallback }).fb.snapshot();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('home_data_stale');
    expect(r.error.details).toBeUndefined();
  });

  it('a simulator bug is a bug, not stale data: its own error, not retryable, reported with its cause (#113)', async () => {
    const primary = sourceOf(() => Promise.resolve(err(toolError('home_not_found', 'Unknown home.'))));
    const broken = sourceOf(() => Promise.resolve(err(toolError('missing_eps_load', 'No EPS load.'))));
    const a = setup({ primary, fallback: broken });
    const r = await a.fb.snapshot();
    expect(!r.ok && r.error).toMatchObject({ code: 'missing_eps_load', retryable: false });
    expect(a.events.find((e) => e.type === 'FALLBACK_FAILED')).toMatchObject({ code: 'missing_eps_load' });

    const throwing = sourceOf(() => Promise.reject(new RangeError('step out of range')));
    const b = setup({ primary, fallback: throwing });
    const t = await b.fb.snapshot();
    expect(!t.ok && t.error).toMatchObject({ code: 'unexpected_error', retryable: false });
    expect(b.events.find((e) => e.type === 'FALLBACK_FAILED')).toMatchObject({ code: 'unexpected_error', errorName: 'RangeError' });
    expect(JSON.stringify(b.events)).not.toContain('out of range');
  });
});
