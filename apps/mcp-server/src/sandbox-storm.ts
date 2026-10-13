import { categoryOf, toolError, type ErrorEnvelope, type HomeId, type Result } from '@cold-reserve/contracts';
import type { Clock, Logger } from '@cold-reserve/core';
import type { CaughtUp } from './modules/storm-mode/observe.js';
import { homeDetail } from './sandbox-log.js';
import type { ToolContext } from './tool.js';

// #379: a visitor sandbox's day runs on its own clock (speed 1 on AWS), so its grid can go down, and come back, with
// no jump and no storm-mode call. The periodic job never visits sandboxes: each request that reads a sandbox checks
// its storm first, so the family hears storm_started and power_back once each, at the next request past the moment.
// The detector passes of one sandbox run one at a time in this container (this check and the judges' clock), so two
// requests at once never tell the family twice.

/** The client id of the catch-up's own detector pass: no tool of the visitor's runs it. */
const CLIENT_ID = 'storm-catch-up';

/** What the check needs of a sandbox as played here; undefined when it is not playing. */
export interface SandboxStormDay {
  /** The play itself: a new play (a restart, new settings) is checked again from scratch. */
  readonly play: object;
  readonly nowMs: number;
  readonly outages: readonly { readonly fromMs: number; readonly toMs: number }[];
}

export interface SandboxStormDeps {
  readonly day: (homeId: HomeId) => SandboxStormDay | undefined;
  /** One catch-up pass of the storm detector (`catchUpStorm`) with the scenario's latest grid return so far. */
  readonly run: (ctx: ToolContext, gridBackAtMs: number | undefined) => Promise<Result<CaughtUp, ErrorEnvelope>>;
  /** How long the grid must stay back before the storm ends (storm-mode `stableGridMinutes`). */
  readonly stableGridMs: number;
  readonly logger: Logger;
  readonly wallClock: Clock;
}

export interface SandboxStorm {
  /** Checks the sandbox's storm at its time now. It never throws and never fails the request: a failure is logged. */
  catchUp(homeId: HomeId, correlationId: string): Promise<void>;
  /** Runs `fn` after any other detector pass of the same sandbox in this container. */
  serial<T>(homeId: HomeId, fn: () => Promise<T>): Promise<T>;
}

export function sandboxStorm(deps: SandboxStormDeps): SandboxStorm {
  const queues = new Map<HomeId, Promise<unknown>>();
  // Plays whose storms are all behind them, with the family told: nothing left to check until the play changes.
  const settled = new WeakSet<object>();
  // Plays whose last check failed and was logged: the next failures stay quiet until a check succeeds.
  const failing = new WeakSet<object>();

  const serial = <T>(homeId: HomeId, fn: () => Promise<T>): Promise<T> => {
    const run = (queues.get(homeId) ?? Promise.resolve()).then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(homeId, tail);
    void tail.then(() => {
      if (queues.get(homeId) === tail) queues.delete(homeId);
    });
    return run;
  };

  const log = (correlationId: string, homeId: HomeId, line: { level: 'info' | 'warn' | 'error'; message: string; event: string; error?: ErrorEnvelope; extra?: Record<string, unknown> }) => {
    deps.logger.log({
      ts: new Date(deps.wallClock.now()).toISOString(),
      level: line.level,
      component: 'mcp-server',
      message: line.message,
      correlationId,
      ...(line.error === undefined ? {} : { code: line.error.code, category: categoryOf(line.error.code) }),
      details: { event: line.event, ...line.extra, ...homeDetail(homeId) },
    });
  };

  async function check(homeId: HomeId, correlationId: string): Promise<void> {
    const day = deps.day(homeId);
    if (day === undefined || settled.has(day.play)) return;
    // Before its first outage a sandbox's grid is up: nothing to tell (preparing a storm is the visitor's request).
    if (!day.outages.some((o) => o.fromMs <= day.nowMs)) return;
    const back = day.outages.filter((o) => o.toMs <= day.nowMs).reduce<number | undefined>((latest, o) => (latest === undefined || o.toMs > latest ? o.toMs : latest), undefined);
    let ran: Result<CaughtUp, ErrorEnvelope>;
    let errorName: string | undefined;
    try {
      ran = await deps.run({ correlationId, clientId: CLIENT_ID, homeId }, back);
    } catch (e) {
      ran = { ok: false, error: toolError('unexpected_error', 'The storm check of a sandbox threw.') };
      errorName = e instanceof Error ? e.name : typeof e;
    }
    if (!ran.ok) {
      // Errors as values: the request goes on with what the sandbox plays; its next request checks again. One line per
      // play until a check succeeds again, not one per request (the page and the phone ask every few seconds).
      if (failing.has(day.play)) return;
      failing.add(day.play);
      log(correlationId, homeId, {
        level: categoryOf(ran.error.code) === 'internal' ? 'error' : 'warn',
        message: 'The storm check of a sandbox failed: the requests go on and the next ones check again.',
        event: 'storm_catch_up_failed',
        error: ran.error,
        ...(errorName === undefined ? {} : { extra: { errorName } }),
      });
      return;
    }
    failing.delete(day.play);
    for (const transition of ran.value.transitions) {
      log(correlationId, homeId, { level: 'info', message: 'The sandbox reached a storm moment on its own clock: the family was told.', event: 'storm_caught_up', extra: { transition } });
    }
    const lastBackMs = Math.max(...day.outages.map((o) => o.toMs));
    if (!ran.value.active && day.nowMs >= lastBackMs + deps.stableGridMs) settled.add(day.play);
  }

  return {
    catchUp: (homeId, correlationId) => serial(homeId, () => check(homeId, correlationId)),
    serial,
  };
}
