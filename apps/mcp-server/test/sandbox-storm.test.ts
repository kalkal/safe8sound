import { HomeIdSchema, err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { memoryLogger } from '@cold-reserve/core';
import { describe, expect, it } from 'vitest';
import type { CaughtUp } from '../src/modules/storm-mode/observe.js';
import { sandboxStorm, type SandboxStormDay } from '../src/sandbox-storm.js';

// #379: a sandbox's own clock reaches its storm with no jump; each request checks it first. The wiring only: when the
// check runs, what it logs, that it never fails the request and that one sandbox's passes run one at a time. The
// once-only rules are the detector's (storm-session tests); the whole path is the judges' clock E2E.

const H = 3_600_000;
const A = HomeIdSchema.parse('demo#00000000000000aa');
const OUTAGE = { fromMs: 3 * H, toMs: 18.5 * H };
const STABLE_MS = 10 * 60_000;

function setup(run: (gridBackAtMs: number | undefined) => Promise<Result<CaughtUp, ErrorEnvelope>> | Result<CaughtUp, ErrorEnvelope>) {
  const logger = memoryLogger();
  let day: SandboxStormDay = { play: {}, nowMs: 1 * H, outages: [OUTAGE] };
  const calls: (number | undefined)[] = [];
  const watch = sandboxStorm({
    day: () => day,
    run: async (ctx, back) => {
      expect(ctx.homeId).toBe(A);
      calls.push(back);
      return run(back);
    },
    stableGridMs: STABLE_MS,
    logger,
    wallClock: { now: () => 0 },
  });
  return { watch, logger, calls, at: (nowMs: number, play: object = day.play) => (day = { play, nowMs, outages: [OUTAGE] }) };
}

const quiet = ok({ transitions: [], active: false });

describe('a sandbox checks its storm on each request (#379)', () => {
  it('before its first outage, nothing runs', async () => {
    const { watch, calls } = setup(() => quiet);
    await watch.catchUp(A, 'corr-1');
    expect(calls).toEqual([]);
  });

  it('inside the outage it runs with no grid return yet, and logs what the family was told, never the sandbox id', async () => {
    const { watch, calls, logger, at } = setup(() => ok({ transitions: ['storm_started'], active: true }));
    at(4 * H);
    await watch.catchUp(A, 'corr-2');
    expect(calls).toEqual([undefined]);
    const line = logger.lines.find((l) => l.details?.['event'] === 'storm_caught_up');
    expect(line).toMatchObject({ level: 'info', correlationId: 'corr-2', details: { transition: 'storm_started', home: 'sandbox' } });
    expect(JSON.stringify(logger.lines)).not.toContain(A);
  });

  it('past the outage it passes the scenario return time; once all is told it stops checking that play', async () => {
    const { watch, calls, at } = setup(() => quiet);
    at(OUTAGE.toMs + STABLE_MS + 60_000);
    await watch.catchUp(A, 'corr-3');
    await watch.catchUp(A, 'corr-4');
    expect(calls).toEqual([OUTAGE.toMs]);
    // A new play (a restart, new settings) is checked again.
    at(OUTAGE.toMs + STABLE_MS + 60_000, {});
    await watch.catchUp(A, 'corr-5');
    expect(calls).toEqual([OUTAGE.toMs, OUTAGE.toMs]);
  });

  it('a failed check is logged once with its code and the requests go on; the next ones check again', async () => {
    let down = true;
    const { watch, calls, logger, at } = setup(() => (down ? err(toolError('store_unavailable', 'The store is down.')) : quiet));
    at(4 * H);
    await expect(watch.catchUp(A, 'corr-6')).resolves.toBeUndefined();
    await watch.catchUp(A, 'corr-7');
    expect(calls).toHaveLength(2);
    const failed = () => logger.lines.filter((l) => l.details?.['event'] === 'storm_catch_up_failed');
    expect(failed()).toHaveLength(1);
    expect(failed()[0]).toMatchObject({ level: 'warn', code: 'store_unavailable', category: 'dependency_unavailable', correlationId: 'corr-6', details: { home: 'sandbox' } });
    // Back up, then down again: a new failure is a new line.
    down = false;
    await watch.catchUp(A, 'corr-8');
    down = true;
    await watch.catchUp(A, 'corr-9');
    expect(failed().map((l) => l.correlationId)).toEqual(['corr-6', 'corr-9']);
  });

  it('a check that throws is logged as an unexpected error, never thrown at the request', async () => {
    const { watch, logger, at } = setup(() => {
      throw new TypeError('boom');
    });
    at(4 * H);
    await expect(watch.catchUp(A, 'corr-8')).resolves.toBeUndefined();
    expect(logger.lines.find((l) => l.details?.['event'] === 'storm_catch_up_failed')).toMatchObject({ level: 'error', code: 'unexpected_error', details: { errorName: 'TypeError' } });
    expect(JSON.stringify(logger.lines)).not.toContain('boom');
  });

  it("one sandbox's detector passes run one at a time: a check and the judges' clock never overlap", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { watch, at } = setup(async () => {
      order.push('check:start');
      await gate;
      order.push('check:end');
      return quiet;
    });
    at(4 * H);
    const first = watch.catchUp(A, 'corr-9');
    const second = watch.serial(A, () => {
      order.push('clock');
      return Promise.resolve();
    });
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['check:start', 'check:end', 'clock']);
  });
});
