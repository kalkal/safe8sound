import type { ProxyOptions } from 'vite';

// The family phone reads GET /phone/inbox (#127) and answers on POST /phone/reply (#24) with its own phone-scoped token. The token stays on the
// dev server (review of #136): the browser asks its own origin, this proxy forwards to the MCP server and
// adds the bearer token. It is read from COLD_RESERVE_PHONE_TOKEN, never a VITE_* variable (Vite would
// put those in the bundle), and it is never logged or printed.

/** A regular-expression key: exactly this path, never a prefix of others. */
export const PHONE_INBOX_PATH = '^/phone/inbox$';
/** The family's replies (queue item 3, #24): POST only. */
export const PHONE_REPLY_PATH = '^/phone/reply$';
const MIN_TOKEN_LENGTH = 32;

type Env = Readonly<Record<string, string | undefined>>;

/** The proxy entry for the dev server, or undefined when the phone is not wired (scripted phone). */
export function phoneProxy(env: Env): Record<string, ProxyOptions> | undefined {
  if (Object.keys(env).some((k) => k.startsWith('VITE_') && k.includes('PHONE_TOKEN'))) {
    throw new Error('Never put the phone token in a VITE_ variable: it would reach the bundle. Use COLD_RESERVE_PHONE_TOKEN.');
  }
  const url = env['COLD_RESERVE_PHONE_URL'];
  const token = env['COLD_RESERVE_PHONE_TOKEN'];
  if (url === undefined && token === undefined) return undefined;
  if (url === undefined || token === undefined) throw new Error('Set both COLD_RESERVE_PHONE_URL and COLD_RESERVE_PHONE_TOKEN, or neither.');
  if (!/^https?:\/\/[^/]+$/.test(url)) throw new Error('COLD_RESERVE_PHONE_URL is the MCP server origin, http(s)://host:port.');
  if (token.length < MIN_TOKEN_LENGTH) throw new Error(`COLD_RESERVE_PHONE_TOKEN is shorter than ${String(MIN_TOKEN_LENGTH)} characters.`);
  return { [PHONE_INBOX_PATH]: forwarding(url, token, 'GET'), [PHONE_REPLY_PATH]: forwarding(url, token, 'POST') };
}

/** One phone path: same-site requests of its one method only, with the token added on the way out. */
function forwarding(url: string, token: string, method: 'GET' | 'POST'): ProxyOptions {
  return {
    target: url,
    changeOrigin: true,
    // Same-site, one method only: a cross-site page or another method never gets the token added (404 here).
    bypass: (req) => {
      const site = req.headers['sec-fetch-site'];
      if (req.method !== method || (site !== undefined && site !== 'same-origin')) return false;
      return undefined;
    },
    // The token lives only in this closure, not in the options the dev server may print.
    configure: (proxy) => {
      proxy.on('proxyReq', (req) => {
        req.setHeader('authorization', `Bearer ${token}`);
        // The route checks Origin, and the page's cookies have no business there.
        req.removeHeader('origin');
        req.removeHeader('cookie');
      });
    },
  };
}

/** VITE_PHONE=inbox needs the proxy: without it the phone would fail every poll, so the dev server refuses to start. */
export function requirePhoneProxy(viteEnv: Env, proxy: Record<string, ProxyOptions> | undefined): void {
  if (viteEnv['VITE_PHONE'] === 'inbox' && proxy === undefined) {
    throw new Error('VITE_PHONE=inbox needs COLD_RESERVE_PHONE_URL and COLD_RESERVE_PHONE_TOKEN for the dev proxy.');
  }
}
