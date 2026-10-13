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

describe('createInboxPhone in remote mode (#267: the sandbox inbox through sim-api)', () => {
  function remote(token: string | undefined, reply: () => Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const phone = createInboxPhone({
      fetchFn: (url, init) => {
        calls.push({ url, init });
        return reply();
      },
      pollMs: 5_000,
      log: () => undefined,
      newId: () => 'poll-2',
      inboxUrl: 'https://site.test/api/v1/phone/inbox',
      authorization: () => (token === undefined ? undefined : `Bearer ${token}`),
    });
    return { phone, calls };
  }

  it('reads GET /v1/phone/inbox with the demo session token, the home being the token\'s sandbox', async () => {
    const { phone, calls } = remote('t-1', () => Promise.resolve(json(200, { messages: [phoneMessage('storm-started')] })));
    phone.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]?.url).toBe('https://site.test/api/v1/phone/inbox');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer t-1');
    expect(new Headers(calls[0]?.init?.headers).get('x-correlation-id')).toBe('poll-2');
    expect(phone.messages().map((m) => m.transition)).toEqual(['storm_started']);
  });

  it('a 429 (the per-code cap, #293) keeps the list and waits retryAfterMs before the next read: no error loop', async () => {
    let n = 0;
    const { phone, calls } = remote('t-1', () => {
      n += 1;
      if (n === 1) return Promise.resolve(json(200, { messages: [phoneMessage('storm-started')] }));
      if (n === 2) return Promise.resolve(json(429, { status: 429, code: 'demo_quota_exceeded', retryAfterMs: 40_000 }));
      return Promise.resolve(json(200, { messages: [phoneMessage('storm-started')] }));
    });
    phone.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(2);
    expect(phone.messages().map((m) => m.transition)).toEqual(['storm_started']);
    // The ticks inside the 40 s wait do not call.
    await vi.advanceTimersByTimeAsync(39_000);
    expect(calls).toHaveLength(2);
    // The 429 came at 5 s: the poll at 45 s reads again.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(3);
  });

  it('does not read while the page is hidden (a tab in the background), and reads again once it is shown', async () => {
    let visible = false;
    const calls: string[] = [];
    const phone = createInboxPhone({
      fetchFn: (url) => {
        calls.push(url);
        return Promise.resolve(json(200, { messages: [] }));
      },
      pollMs: 5_000,
      log: () => undefined,
      newId: () => 'poll-3',
      inboxUrl: 'https://site.test/api/v1/phone/inbox',
      authorization: () => 'Bearer t-1',
      isVisible: () => visible,
    });
    phone.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
    visible = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
  });

  it('an expired or refused session token ends the session once, like the agent: no 401 every 5 s (review of #296)', async () => {
    for (const code of ['signature_expired', 'invalid_signature', 'missing_token'] as const) {
      let token: string | undefined = 't-1';
      const failures: string[] = [];
      const calls: string[] = [];
      const phone = createInboxPhone({
        fetchFn: (url) => {
          calls.push(url);
          return Promise.resolve(json(401, { status: 401, code }));
        },
        pollMs: 5_000,
        log: () => undefined,
        newId: () => 'poll-4',
        inboxUrl: 'https://site.test/api/v1/phone/inbox',
        authorization: () => (token === undefined ? undefined : `Bearer ${token}`),
        onAuthFailure: (reason) => {
          failures.push(reason);
          token = undefined;
        },
      });
      const stop = phone.subscribe(() => undefined);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(failures).toEqual([code]);
      expect(calls).toHaveLength(1);
      stop();
    }
  });

  it('another refusal (a 503) is not an auth failure: the session stays', async () => {
    const failures: string[] = [];
    const phone = createInboxPhone({
      fetchFn: () => Promise.resolve(json(503, { status: 503, code: 'agent_unavailable' })),
      pollMs: 5_000,
      log: () => undefined,
      newId: () => 'poll-5',
      inboxUrl: 'https://site.test/api/v1/phone/inbox',
      authorization: () => 'Bearer t-1',
      onAuthFailure: (reason) => failures.push(reason),
    });
    phone.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(failures).toEqual([]);
  });

  it('a 429 without retryAfterMs waits one poll, as before', async () => {
    const { phone, calls } = remote('t-1', () => Promise.resolve(json(429, { status: 429, code: 'demo_quota_exceeded' })));
    phone.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(3);
  });

  it('without a session (no demo code yet) it does not call at all', async () => {
    const { phone, calls } = remote(undefined, () => Promise.resolve(json(200, { messages: [] })));
    phone.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
  });

  it('cannot reply until sim-api has a reply route: no reply buttons in remote mode', () => {
    const { phone } = remote('t-1', () => Promise.resolve(json(200, { messages: [] })));
    expect(phone.reply).toBeUndefined();
  });
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
    reply = () => Promise.resolve(json(200, { messages: [{ text: 'Ana, unchecked' }] }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(phone.messages().map((m) => m.transition)).toEqual(['storm_started']);
    expect(lines.map((l) => [l.level, l.code, l.correlationId])).toEqual([
      ['warn', 'store_unavailable', 'poll-1'],
      ['warn', 'phone_inbox_unreachable', 'poll-1'],
      ['warn', 'output_schema_violation', 'poll-1'],
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/Ana|alert for/);
  });

  describe('reply (queue item 3, #24): the family answers from the phone', () => {
    it('posts the reply to its own origin with a correlation id and no credentials; the token is the proxy\'s', async () => {
      const { phone, calls } = setup(() => Promise.resolve(json(200, { recorded: { role: 'daughter', reply: 'on_my_way', at: '2026-07-17T19:45:00Z' } })));
      const out = await phone.reply?.('on_my_way');
      expect(out).toEqual({ ok: true });
      expect(calls[0]?.url).toBe('/phone/reply');
      expect(calls[0]?.init).toMatchObject({ method: 'POST', credentials: 'omit', body: JSON.stringify({ reply: 'on_my_way' }) });
      expect((calls[0]?.init?.headers as Record<string, string>)['x-correlation-id']).toBe('poll-1');
      expect(JSON.stringify(calls[0]?.init)).not.toMatch(/Bearer/i);
    });

    it('check status brings back the safe room', async () => {
      const status = { safeRoomId: 'bedroom-1', tempC: 25.5, occupantRoles: ['grandpa'], level: 'essential', levelReason: 'storm', safeHours: 5, safeUntil: '2026-07-18T01:20:00+02:00', stormPhase: 'active', origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated', scenario: 'storm-blackout' }, homeLink: 'ok' };
      const { phone } = setup(() => Promise.resolve(json(200, { recorded: { role: 'daughter', reply: 'check_status', at: '2026-07-17T19:45:00Z' }, status })));
      const out = await phone.reply?.('check_status');
      expect(out).toMatchObject({ ok: true, status: { safeUntil: '2026-07-18T01:20:00+02:00', tempC: 25.5 } });
    });

    it('too soon: the code and when to retry, from Retry-After; logged with its code, never a text', async () => {
      const { phone, lines } = setup(() =>
        Promise.resolve(new Response(JSON.stringify({ code: 'family_reply_rate_limited', detail: 'x' }), { status: 429, headers: { 'content-type': 'application/problem+json', 'retry-after': '20' } })),
      );
      expect(await phone.reply?.('on_my_way')).toEqual({ ok: false, code: 'family_reply_rate_limited', retryAfterMs: 20_000 });
      expect(lines.at(-1)).toMatchObject({ level: 'warn', code: 'family_reply_rate_limited', correlationId: 'poll-1' });
    });

    it('an unreachable server is a failure the panel can say, never a throw', async () => {
      const { phone, lines } = setup(() => Promise.reject(new TypeError('offline')));
      expect(await phone.reply?.('on_my_way')).toEqual({ ok: false, code: 'phone_reply_unreachable' });
      expect(lines.at(-1)).toMatchObject({ code: 'phone_reply_unreachable' });
    });
  });
});

describe('createInboxPhone refresh (time pack: the simulated clock moved)', () => {
  it('reads at once while the panel is on screen, not at the next poll; nothing while it is not', async () => {
    const { phone, calls } = setup(() => Promise.resolve(json(200, { messages: [phoneMessage('storm-started')] })));
    phone.refresh?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);
    phone.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    phone.refresh?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
  });
});
