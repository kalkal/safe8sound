import './no-network.js';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { describe, expect, it, vi } from 'vitest';
import { cachedOnSuccess, readMcpTokenFromSsm } from '../src/ssm-token.js';

// G1a, decided in #17: on AgentCore the agent's MCP token is an SSM SecureString read at startup (explicit
// timeout, kept in memory only, never logged). A fake client stands in for SSM: nothing leaves the machine.

const NAME = '/cold-reserve/dev/agent/mcp-token';
const VALUE = 'v'.repeat(40);
const sdkError = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`${name}: User arn:aws:iam::123456789012:role/x`), { name, ...extra });

describe('readMcpTokenFromSsm', () => {
  it('asks for the decrypted parameter by name and keeps the value out of every printout', async () => {
    const send = vi.fn<(cmd: GetParameterCommand) => Promise<{ Parameter: { Value: string } }>>(() => Promise.resolve({ Parameter: { Value: VALUE } }));
    const result = await readMcpTokenFromSsm(NAME, { client: { send }, timeoutMs: 1000 });
    expect(result.ok && result.value.reveal()).toBe(VALUE);
    expect(send.mock.calls[0]?.[0].input).toEqual({ Name: NAME, WithDecryption: true });
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });

  it.each([
    ['a missing parameter', sdkError('ParameterNotFound')],
    ['a denied read', sdkError('AccessDeniedException', { $fault: 'client' })],
  ])('answers invalid_config for %s, without the SDK text', async (_name, error) => {
    const result = await readMcpTokenFromSsm(NAME, { client: { send: () => Promise.reject(error) }, timeoutMs: 1000 });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(JSON.stringify(result)).not.toContain('arn:aws');
  });

  it.each([
    ['throttling', sdkError('ThrottlingException', { $retryable: { throttling: true } })],
    ['a server fault', sdkError('InternalServerError', { $fault: 'server' })],
    ['a network failure', new TypeError('fetch failed')],
  ])('answers config_unavailable (transient) for %s', async (_name, error) => {
    const result = await readMcpTokenFromSsm(NAME, { client: { send: () => Promise.reject(error) }, timeoutMs: 1000 });
    expect(result).toMatchObject({ ok: false, error: { code: 'config_unavailable', category: 'dependency_unavailable' } });
  });

  it('answers config_unavailable after its own timeout, and aborts the request', async () => {
    let aborted = false;
    const send = (_cmd: GetParameterCommand, opts?: { abortSignal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        opts?.abortSignal?.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    const result = await readMcpTokenFromSsm(NAME, { client: { send }, timeoutMs: 20 });
    expect(result).toMatchObject({ ok: false, error: { code: 'config_unavailable' } });
    expect(aborted).toBe(true);
  });

  it('refuses a value that is not a valid token (empty or too short) with invalid_config', async () => {
    for (const Value of [undefined, '', 'short']) {
      const result = await readMcpTokenFromSsm(NAME, { client: { send: () => Promise.resolve({ Parameter: { Value } }) }, timeoutMs: 1000 });
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    }
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
