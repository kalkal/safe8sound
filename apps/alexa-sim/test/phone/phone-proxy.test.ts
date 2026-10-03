import { describe, expect, it } from 'vitest';
import { PHONE_INBOX_PATH, PHONE_REPLY_PATH, phoneProxy, requirePhoneProxy } from '../../vite.phone-proxy.js';

// The family phone's token stays on the dev server (review of #136): the browser asks its own origin for
// /phone/inbox, the Vite proxy adds the bearer token. Never a VITE_* variable, never in the bundle or logs.

const TOKEN = 'p'.repeat(40);
const env = { COLD_RESERVE_PHONE_URL: 'http://127.0.0.1:3316', COLD_RESERVE_PHONE_TOKEN: TOKEN };

/** Runs the proxy's configure hook on a fake proxy and a fake outgoing request. */
function forward(options: NonNullable<ReturnType<typeof phoneProxy>>[string]) {
  const headers = new Map<string, string>([
    ['origin', 'http://127.0.0.1:5318'],
    ['cookie', 'session=1'],
    ['accept', 'application/json'],
  ]);
  let onRequest: ((req: { setHeader(k: string, v: string): void; removeHeader(k: string): void }) => void) | undefined;
  const fakeProxy = {
    on: (event: string, handler: typeof onRequest) => {
      if (event === 'proxyReq') onRequest = handler;
    },
  };
  options.configure?.(fakeProxy as never, options);
  onRequest?.({ setHeader: (k, v) => headers.set(k.toLowerCase(), v), removeHeader: (k) => headers.delete(k.toLowerCase()) });
  return headers;
}

describe('phoneProxy (vite dev server)', () => {
  it('proxies exactly /phone/inbox to the MCP server, adding the phone token there', () => {
    const proxy = phoneProxy(env);
    expect(PHONE_INBOX_PATH).toBe('^/phone/inbox$');
    expect(Object.keys(proxy ?? {})).toEqual([PHONE_INBOX_PATH, PHONE_REPLY_PATH]);
    const options = proxy?.[PHONE_INBOX_PATH];
    if (!options) throw new Error('no proxy');
    expect(options.target).toBe('http://127.0.0.1:3316');
    const headers = forward(options);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    // The route checks Origin and has no use for the page's cookies.
    expect(headers.has('origin')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
  });

  it('forwards only same-site GET requests: anything else is not proxied (404 from the dev server)', () => {
    const options = phoneProxy(env)?.[PHONE_INBOX_PATH];
    const bypass = (method: string, site?: string) =>
      options?.bypass?.({ method, headers: site === undefined ? {} : { 'sec-fetch-site': site } } as never, undefined, options);
    expect(bypass('GET', 'same-origin')).toBeUndefined();
    expect(bypass('GET')).toBeUndefined();
    expect(bypass('POST', 'same-origin')).toBe(false);
    expect(bypass('GET', 'cross-site')).toBe(false);
    expect(bypass('GET', 'same-site')).toBe(false);
  });

  it('proxies exactly /phone/reply for same-site POST only, adding the token there (queue item 3, #24)', () => {
    expect(PHONE_REPLY_PATH).toBe('^/phone/reply$');
    const options = phoneProxy(env)?.[PHONE_REPLY_PATH];
    if (!options) throw new Error('no reply proxy');
    expect(forward(options).get('authorization')).toBe(`Bearer ${TOKEN}`);
    const bypass = (method: string, site?: string) =>
      options.bypass?.({ method, headers: site === undefined ? {} : { 'sec-fetch-site': site } } as never, undefined, options);
    expect(bypass('POST', 'same-origin')).toBeUndefined();
    expect(bypass('GET', 'same-origin')).toBe(false);
    expect(bypass('POST', 'cross-site')).toBe(false);
  });

  it('never puts the token in the options themselves (they can be printed by the dev server)', () => {
    expect(JSON.stringify(phoneProxy(env))).not.toContain(TOKEN);
  });

  it('is off when neither variable is set (the scripted phone needs no server)', () => {
    expect(phoneProxy({})).toBeUndefined();
  });

  it.each([
    ['a URL without a token', { COLD_RESERVE_PHONE_URL: 'http://127.0.0.1:3316' }],
    ['a token without a URL', { COLD_RESERVE_PHONE_TOKEN: TOKEN }],
    ['a short token', { ...env, COLD_RESERVE_PHONE_TOKEN: 'short' }],
    ['a URL that is not http(s)', { ...env, COLD_RESERVE_PHONE_URL: 'file:///etc' }],
    ['the token in a VITE_ variable (it would reach the bundle)', { ...env, VITE_PHONE_TOKEN: TOKEN }],
  ])('refuses %s, naming the problem but never the token', (_name, bad) => {
    expect(() => phoneProxy(bad)).toThrow(/COLD_RESERVE_PHONE|VITE_/);
    try {
      phoneProxy(bad);
    } catch (e) {
      expect(String(e)).not.toContain(TOKEN);
    }
  });
});

describe('requirePhoneProxy', () => {
  it('refuses VITE_PHONE=inbox without the proxy, instead of a phone that fails every 5 s', () => {
    expect(() => {
      requirePhoneProxy({ VITE_PHONE: 'inbox' }, undefined);
    }).toThrow(/COLD_RESERVE_PHONE_URL/);
    expect(() => {
      requirePhoneProxy({ VITE_PHONE: 'inbox' }, phoneProxy(env));
    }).not.toThrow();
    expect(() => {
      requirePhoneProxy({}, undefined);
    }).not.toThrow();
  });
});
