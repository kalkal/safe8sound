import { describe, expect, it, vi } from 'vitest';
import { cachedOnSuccess, extensionReader, sdkReader, type GetParameter } from '../src/index.js';

// One interface, two transports (R14, #17): a ParameterReader reads one SecureString by name and answers
// the value, `invalid_config` (our setup: retrying cannot help) or `config_unavailable` (transient). The
// SDK transport takes the GetParameter call from the caller, so this package needs no AWS SDK. Fakes
// only: nothing leaves the machine.

const NAME = '/cold-reserve/dev/agent/mcp-token';
const VALUE = 'v'.repeat(40);
const sdkError = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`${name}: User arn:aws:iam::123456789012:role/x`), { name, ...extra });

describe('sdkReader', () => {
  it('asks for the decrypted parameter by name and answers its value', async () => {
    const get = vi.fn<GetParameter>(() => Promise.resolve({ Parameter: { Value: VALUE } }));
    expect(await sdkReader({ getParameter: get, timeoutMs: 1000 })(NAME)).toEqual({ ok: true, value: VALUE });
    expect(get.mock.calls[0]?.[0]).toEqual({ Name: NAME, WithDecryption: true });
  });

  it.each([
    ['a missing parameter', sdkError('ParameterNotFound')],
    ['a denied read', sdkError('AccessDeniedException', { $fault: 'client' })],
    ['a bad KMS key', sdkError('InvalidKeyId')],
  ])('answers invalid_config for %s, without the SDK text', async (_name, error) => {
    const result = await sdkReader({ getParameter: () => Promise.reject(error), timeoutMs: 1000 })(NAME);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(JSON.stringify(result)).not.toContain('arn:aws');
  });

  it.each([
    ['throttling', sdkError('ThrottlingException', { $retryable: { throttling: true } })],
    ['a server fault', sdkError('InternalServerError', { $fault: 'server' })],
    ['a network failure', new TypeError('fetch failed')],
  ])('answers config_unavailable (transient) for %s', async (_name, error) => {
    const result = await sdkReader({ getParameter: () => Promise.reject(error), timeoutMs: 1000 })(NAME);
    expect(result).toMatchObject({ ok: false, error: { code: 'config_unavailable', category: 'dependency_unavailable' } });
  });

  it('answers config_unavailable after its own timeout, and aborts the request', async () => {
    let aborted = false;
    const getParameter: GetParameter = (_input, options) =>
      new Promise<never>((_resolve, reject) => {
        options.abortSignal.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    expect(await sdkReader({ getParameter, timeoutMs: 20 })(NAME)).toMatchObject({ ok: false, error: { code: 'config_unavailable' } });
    expect(aborted).toBe(true);
  });

  it('answers invalid_config when the parameter holds no string value', async () => {
    for (const Parameter of [undefined, {}, { Value: undefined }]) {
      expect(await sdkReader({ getParameter: () => Promise.resolve({ Parameter }), timeoutMs: 1000 })(NAME)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    }
  });
});

describe('extensionReader', () => {
  it('reads through the Parameters and Secrets extension, with the same answers', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ Parameter: { Value: VALUE } }))));
    expect(await extensionReader({ fetchFn, sessionToken: 'session', timeoutMs: 1000 })(NAME)).toEqual({ ok: true, value: VALUE });
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toContain(encodeURIComponent(NAME));
  });
});

describe('cachedOnSuccess', () => {
  it('keeps a success for good, and tries again after a failure', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'config_unavailable' } })
      .mockResolvedValueOnce({ ok: true, value: 'token' })
      .mockResolvedValueOnce({ ok: true, value: 'other' });
    const get = cachedOnSuccess(load);
    expect(await get()).toMatchObject({ ok: false });
    expect(await get()).toEqual({ ok: true, value: 'token' });
    expect(await get()).toEqual({ ok: true, value: 'token' });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
