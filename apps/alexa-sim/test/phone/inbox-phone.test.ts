import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEvent } from '../../src/log.js';
import { createInboxPhone } from '../../src/phone/inbox-phone.js';
import { phoneMessage } from '../../src/phone/phone-fixtures.js';

// The phone reads the real inbox (review of #136): same-origin GET /phone/inbox through the dev proxy,
// polled while the panel is on screen. It never sends or logs a token, and never logs a message text.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(reply: () => Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const lines: LogEvent[] = [];
  const phone = createInboxPhone({
    fetchFn: (url, init) => {
      calls.push({ url, init });
      return reply();
    },
    pollMs: 5_000,
    log: (e) => lines.push(e),
    newId: () => 'poll-1',
  });
  return { phone, calls, lines };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createInboxPhone', () => {
  it('polls only while someone looks, and shows the inbox newest first', async () => {
    const { phone, calls } = setup(() => Promise.resolve(json(200, { messages: [phoneMessage('power-back'), phoneMessage('storm-started')] })));
    expect(calls).toHaveLength(0);
    const stop = phone.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(phone.messages().map((m) => m.transition)).toEqual(['power_back', 'storm_started']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(2);
  });

  it('asks its own origin, with a correlation id and no credentials: the token is added by the dev server', async () => {
    const { phone, calls } = setup(() => Promise.resolve(json(200, { messages: [] })));
    phone.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]?.url).toBe('/phone/inbox');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('x-correlation-id')).toBe('poll-1');
    expect(headers.has('authorization')).toBe(false);
    expect(calls[0]?.init?.credentials).toBe('omit');
  });

  it('keeps the same snapshot when nothing changed, and tells subscribers only on a change', async () => {
    const { phone } = setup(() => Promise.resolve(json(200, { messages: [phoneMessage('storm-started')] })));
    const listener = vi.fn();
    phone.subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    const first = phone.messages();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(phone.messages()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('never overlaps polls, and gives up on a slow reply before the next one is due', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const lines: LogEvent[] = [];
    // A reply that never comes on its own: only the abort signal ends it.
    const phone = createInboxPhone({
      fetchFn: (_url, init) => {
        calls.push(init);
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('timed out', 'AbortError'));
          });
        });
      },
      pollMs: 5_000,
      log: (e) => lines.push(e),
      newId: () => 'poll-1',
    });
    phone.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500); // past the 4 s timeout, before the next poll
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(lines.map((l) => l.code)).toEqual(['phone_inbox_timeout']);
    await vi.advanceTimersByTimeAsync(500); // the next poll starts: the first one is over
    expect(calls).toHaveLength(2);
  });

  it('skips a tick while the previous read is still running', async () => {
    let release: (r: Response) => void = () => undefined;
    let count = 0;
    const phone = createInboxPhone({
      fetchFn: () => {
        count += 1;
        return new Promise<Response>((resolve) => (release = resolve));
      },
      pollMs: 1_000,
      timeoutMs: 10_000,
      log: () => undefined,
      newId: () => 'poll-1',
    });
    phone.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(count).toBe(1);
    release(json(200, { messages: [] }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(count).toBe(2);
  });

  it('a refused or failed read keeps what is on screen and logs the code, never a text', async () => {
    let reply = () => Promise.resolve(json(200, { messages: [phoneMessage('storm-started')] }));
    const { phone, lines } = setup(() => reply());
    phone.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    reply = () => Promise.resolve(json(503, { type: 'about:blank', title: 'Store unavailable', status: 503, code: 'store_unavailable' }));
    await vi.advanceTimersByTimeAsync(5_000);
    reply = () => Promise.reject(new TypeError('network'));
    await vi.advanceTimersByTimeAsync(5_000);
    reply = () => Promise.resolve(json(200, { messages: [{ text: 'Sara, unchecked' }] }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(phone.messages().map((m) => m.transition)).toEqual(['storm_started']);
    expect(lines.map((l) => [l.level, l.code, l.correlationId])).toEqual([
      ['warn', 'store_unavailable', 'poll-1'],
      ['warn', 'phone_inbox_unreachable', 'poll-1'],
      ['warn', 'output_schema_violation', 'poll-1'],
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/Sara|alert for/);
  });
});
