import type { LogEntry } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { createRemoteLogSink, type RemoteLogOptions } from '../src/remote-log.js';

// The browser's warnings and errors reach sim-api's POST /v1/log (#125): batched, capped, sent in the background
// with the demo token, dropped on any failure. The sink never throws, never waits, never logs.
const TURN = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';
const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  ts: '2026-10-01T09:00:00.000Z',
  level: 'warn',
  component: 'alexa-sim',
  message: 'agent_unavailable',
  correlationId: TURN,
  code: 'agent_unavailable',
  category: 'dependency_unavailable',
  ...over,
});

function harness(over: Partial<RemoteLogOptions> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const timers: (() => void)[] = [];
  let nowMs = 0;
  let answer: () => Promise<Response> = () => Promise.resolve(new Response(null, { status: 204 }));
  const remote = createRemoteLogSink({
    url: 'https://site.test/api/v1/log',
    token: () => 'demo-token',
    fetchFn: (url, init) => {
      calls.push({ url, init });
      return answer();
    },
    schedule: (run) => {
      timers.push(run);
    },
    now: () => nowMs,
    ...over,
  });
  const tick = async () => {
    const due = timers.splice(0);
    for (const run of due) run();
    // Let the fetch promise settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const bodies = () => calls.map((c) => JSON.parse(c.init.body as string) as { lines: LogEntry[] });
  return {
    remote,
    calls,
    timers,
    tick,
    bodies,
    advance: (ms: number) => {
      nowMs += ms;
    },
    answerWith: (f: () => Promise<Response>) => {
      answer = f;
    },
  };
}

describe('createRemoteLogSink', () => {
  it('sends warnings and errors in one batch after a short wait, with the demo token, keepalive, and the first line’s turn id', async () => {
    const h = harness();
    h.remote.sink(entry());
    h.remote.sink(entry({ level: 'error', message: 'unexpected_error', code: 'unexpected_error', category: 'internal' }));
    expect(h.calls).toEqual([]);
    expect(h.timers).toHaveLength(1);
    await h.tick();
    expect(h.calls).toHaveLength(1);
    const [call] = h.calls;
    expect(call?.url).toBe('https://site.test/api/v1/log');
    expect(call?.init).toMatchObject({ method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', authorization: 'Bearer demo-token', 'x-correlation-id': TURN } });
    expect(h.bodies()[0]?.lines.map((l) => l.message)).toEqual(['agent_unavailable', 'unexpected_error']);
  });

  it('keeps info and debug lines in the browser', async () => {
    const h = harness();
    h.remote.sink(entry({ level: 'info', message: 'phone_delivered' }));
    h.remote.sink(entry({ level: 'debug', message: 'x' }));
    await h.tick();
    expect(h.calls).toEqual([]);
  });

  it('never sends a stack, and drops a line whose correlation id is not a UUID', async () => {
    const h = harness();
    h.remote.sink(entry({ stack: 'TypeError\n at secret' }));
    h.remote.sink(entry({ correlationId: 'not-a-uuid' }));
    await h.tick();
    expect(h.bodies()[0]?.lines).toHaveLength(1);
    expect(JSON.stringify(h.bodies())).not.toContain('secret');
    expect(h.remote.dropped()).toBe(1);
  });

  it('sends at most 10 lines a request and keeps at most 20 waiting: the rest are dropped', async () => {
    const h = harness();
    for (let i = 0; i < 25; i++) h.remote.sink(entry());
    expect(h.remote.dropped()).toBe(5);
    await h.tick();
    await h.tick();
    expect(h.bodies().map((b) => b.lines.length)).toEqual([10, 10]);
  });

  it('sends at most 100 lines for the whole page: an error in a loop stops reaching the server', async () => {
    const h = harness();
    for (let round = 0; round < 12; round++) {
      for (let i = 0; i < 10; i++) h.remote.sink(entry());
      await h.tick();
    }
    expect(h.bodies().reduce((n, b) => n + b.lines.length, 0)).toBe(100);
    expect(h.remote.dropped()).toBe(20);
  });

  it('without a demo session the lines are dropped, nothing is sent', async () => {
    const h = harness({ token: () => undefined });
    h.remote.sink(entry());
    await h.tick();
    expect(h.calls).toEqual([]);
    expect(h.remote.dropped()).toBe(1);
  });

  it.each([
    ['offline (fetch rejects)', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a refusal (429)', () => Promise.resolve(new Response(null, { status: 429 }))],
  ])('%s: the batch is dropped without throwing, and nothing is sent for a minute', async (_, fail) => {
    const h = harness();
    h.answerWith(fail);
    h.remote.sink(entry());
    await h.tick();
    expect(h.calls).toHaveLength(1);
    h.answerWith(() => Promise.resolve(new Response(null, { status: 204 })));
    h.remote.sink(entry());
    await h.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.remote.dropped()).toBe(2);
    h.advance(60_001);
    h.remote.sink(entry());
    await h.tick();
    expect(h.calls).toHaveLength(2);
  });

  it('a fetch that throws at once is a dropped batch too, never an exception for the caller', async () => {
    const h = harness({
      fetchFn: () => {
        throw new TypeError('blocked');
      },
    });
    expect(() => {
      h.remote.sink(entry());
    }).not.toThrow();
    await expect(h.tick()).resolves.toBeUndefined();
    expect(h.remote.dropped()).toBe(1);
  });

  it('flush sends what is waiting at once (the page is closing)', () => {
    const h = harness();
    h.remote.sink(entry());
    h.remote.flush();
    expect(h.calls).toHaveLength(1);
  });
});
