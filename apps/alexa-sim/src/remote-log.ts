import { CORRELATION_ID_HEADER, CorrelationIdSchema, withoutStack, type LogEntry } from '@cold-reserve/contracts';
import type { LogSink } from '@cold-reserve/core';

// The browser's warnings and errors reach sim-api's POST /v1/log (#125, plan §10.7), so the demo's failures are
// in the server log next to the turn they belong to. Best effort by design: the sink only queues; a timer sends
// a small batch in the background (fetch keepalive, so a closing page still sends; sendBeacon cannot carry the
// demo token). Any failure drops the batch and pauses the sending for a minute. The sink never throws, never
// waits, and never logs: a failure to send cannot produce a line that is sent again.

export interface RemoteLogOptions {
  /** sim-api's /v1/log (on AWS the site's own /api/v1/log). */
  url: string;
  /** The demo session token; without one the lines stay in the browser. */
  token: () => string | undefined;
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  /** Runs `run` after `ms` (setTimeout in the page). */
  schedule: (run: () => void, ms: number) => void;
  now: () => number;
}

/** The wait that gathers the lines of one moment into one request. */
const BATCH_WAIT_MS = 2000;
/** sim-api accepts at most 10 lines a request. */
const MAX_BATCH = 10;
/** Lines waiting to be sent; beyond, a new line is dropped. */
const MAX_QUEUED = 20;
/** Lines one page sends at most: an error in a loop stops reaching the server. */
const MAX_PER_PAGE = 100;
/** After a failed send (offline, 429, a refused token), nothing is sent for this long. */
const PAUSE_MS = 60_000;

const SENT_LEVELS: ReadonlySet<LogEntry['level']> = new Set(['warn', 'error']);

export function createRemoteLogSink(options: RemoteLogOptions): { sink: LogSink; flush: () => void; dropped: () => number } {
  const queue: Omit<LogEntry, 'stack'>[] = [];
  let accepted = 0;
  let dropped = 0;
  let pausedUntil = 0;
  let scheduled = false;

  const fail = (lines: number) => {
    dropped += lines;
    pausedUntil = options.now() + PAUSE_MS;
  };

  function flush(): void {
    scheduled = false;
    if (queue.length === 0) return;
    const token = options.token();
    if (token === undefined) {
      dropped += queue.splice(0).length;
      return;
    }
    const batch = queue.splice(0, MAX_BATCH);
    if (queue.length > 0) later();
    const first = batch[0];
    try {
      void options
        .fetchFn(options.url, {
          method: 'POST',
          keepalive: true,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(first === undefined ? {} : { [CORRELATION_ID_HEADER]: first.correlationId }) },
          body: JSON.stringify({ lines: batch }),
        })
        .then(
          (response) => {
            if (!response.ok) fail(batch.length);
          },
          () => {
            fail(batch.length);
          },
        );
    } catch {
      // A fetch that throws at once (blocked by the page): the same as a failed one.
      fail(batch.length);
    }
  }

  function later(): void {
    if (scheduled) return;
    scheduled = true;
    options.schedule(flush, BATCH_WAIT_MS);
  }

  const sink: LogSink = (entry) => {
    if (!SENT_LEVELS.has(entry.level)) return;
    // sim-api accepts only a UUID: a line without one would refuse the whole batch.
    if (accepted >= MAX_PER_PAGE || options.now() < pausedUntil || queue.length >= MAX_QUEUED || !CorrelationIdSchema.safeParse(entry.correlationId).success) {
      dropped += 1;
      return;
    }
    accepted += 1;
    queue.push(withoutStack(entry));
    later();
  };

  return { sink, flush, dropped: () => dropped };
}
