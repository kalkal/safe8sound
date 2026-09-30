import './no-network.js';
import { ConcurrentInvocationError, ContextWindowOverflowError, Message, MaxTokensError, ModelError, ModelThrottledError } from '@strands-agents/sdk';
import { describe, expect, it } from 'vitest';
import { classifyFailure } from '../src/failure.js';

const withCode = (code: unknown, message = 'Streamable HTTP error') => Object.assign(new Error(message), { code });
const network = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code }) });

describe('classifyFailure: only outages are retryable (a blind retry doubles the model cost)', () => {
  it.each([
    ['a throttled model', new ModelThrottledError('slow down')],
    ['a model outage', new ModelError('model unavailable')],
    ['the MCP server refusing the connection', network('ECONNREFUSED')],
    ['a reset connection', network('ECONNRESET')],
    ['an MCP server 503', withCode(503)],
    ['an MCP server 429', withCode(429)],
  ])('%s -> agent_unavailable, retryable', (_name, error) => {
    expect(classifyFailure(error)).toMatchObject({ kind: 'value', error: { code: 'agent_unavailable', retryable: true } });
  });

  it.each([
    ['a wrong MCP token (401)', withCode(401)],
    ['a forbidden MCP origin (403)', withCode(403)],
  ])('%s -> invalid_config, not retryable', (_name, error) => {
    expect(classifyFailure(error)).toMatchObject({ kind: 'value', error: { code: 'invalid_config', retryable: false } });
  });

  it.each([
    ['max tokens reached', new MaxTokensError('cut', new Message({ role: 'assistant', content: [] }))],
    ['the context window overflowing', new ContextWindowOverflowError('too long')],
    ['a concurrent invocation on the same agent', new ConcurrentInvocationError('busy')],
    ['an unknown failure', new Error('boom')],
  ])('%s -> unexpected_error, not retryable', (_name, error) => {
    expect(classifyFailure(error)).toMatchObject({ kind: 'value', error: { code: 'unexpected_error', retryable: false } });
  });

  it.each([
    ['a TypeError without a network cause', new TypeError('x is not a function'), TypeError],
    ['a RangeError', new RangeError('bad index'), RangeError],
    ['a ReferenceError', new ReferenceError('y is not defined'), ReferenceError],
    ['a bug inside the model, wrapped by Strands in a ModelError', new ModelError('wrapped', { cause: new TypeError('policy is not a function') }), TypeError],
  ] as const)('%s is a bug: rethrown, never turned into a value', (_name, error, rethrown) => {
    const failure = classifyFailure(error);
    expect(failure.kind).toBe('bug');
    // The original bug is what gets rethrown, not Strands' wrapper.
    expect(failure.kind === 'bug' ? failure.error : undefined).toBeInstanceOf(rethrown);
  });

  it('never puts the error message in the envelope', () => {
    const result = classifyFailure(withCode(401, 'token abc123 rejected at /secret/path'));
    expect(JSON.stringify(result)).not.toMatch(/abc123|secret/);
  });
});
