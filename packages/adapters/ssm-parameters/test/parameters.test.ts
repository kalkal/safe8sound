import { ok } from '@cold-reserve/contracts';
import { describe, expect, it, vi } from 'vitest';
import { readParameter } from '../src/index.js';

// Moved from apps/mcp-server (#17, the sim-api stack): one SSM reader for every Lambda.

describe('readParameter (SSM through the Parameters and Secrets Lambda extension)', () => {
  it('reads a decrypted SecureString with the session token', async () => {
    const fetchFn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(new Response(JSON.stringify({ Parameter: { Value: 'agent@demo=secret' } }))),
    );
    const result = await readParameter('/cold-reserve/dev/mcp-clients', { fetchFn, sessionToken: 'tok', timeoutMs: 1000 });
    expect(result).toEqual(ok('agent@demo=secret'));
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('http://localhost:2773/systemsmanager/parameters/get?name=%2Fcold-reserve%2Fdev%2Fmcp-clients&withDecryption=true');
    expect(new Headers(init?.headers).get('x-aws-parameters-secrets-token')).toBe('tok');
  });

  it('fails with config_unavailable on a 5xx or a network error (transient), invalid_config otherwise', async () => {
    const answer = (status: number) => () => Promise.resolve(new Response('x', { status }));
    expect(await readParameter('/p', { fetchFn: answer(503), sessionToken: 'tok', timeoutMs: 1000 })).toMatchObject({ ok: false, error: { code: 'config_unavailable' } });
    const refused = () => Promise.reject(new TypeError('fetch failed'));
    expect(await readParameter('/p', { fetchFn: refused, sessionToken: 'tok', timeoutMs: 1000 })).toMatchObject({ ok: false, error: { code: 'config_unavailable' } });
    expect(await readParameter('/p', { fetchFn: answer(400), sessionToken: 'tok', timeoutMs: 1000 })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });

  it('treats the extension\'s "not ready" 400 as transient: config_unavailable with retryAfterMs (review of #134)', async () => {
    const notReady = () => Promise.resolve(new Response('not ready to serve traffic, please wait', { status: 400 }));
    const result = await readParameter('/p', { fetchFn: notReady, sessionToken: 'tok', timeoutMs: 1000 });
    expect(result).toMatchObject({ ok: false, error: { code: 'config_unavailable', category: 'dependency_unavailable', retryAfterMs: 1000 } });
    expect(JSON.stringify(result)).not.toContain('please wait');
  });

  it('fails with invalid_config on a non-200 answer, without the value', async () => {
    const fetchFn = () => Promise.resolve(new Response('denied', { status: 403 }));
    const result = await readParameter('/p', { fetchFn, sessionToken: 'tok', timeoutMs: 1000 });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });

  it('fails with config_unavailable (transient, 503) after the explicit timeout', async () => {
    const fetchFn = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    const result = await readParameter('/p', { fetchFn, sessionToken: 'tok', timeoutMs: 20 });
    expect(result).toMatchObject({ ok: false, error: { code: 'config_unavailable' } });
  });
});
