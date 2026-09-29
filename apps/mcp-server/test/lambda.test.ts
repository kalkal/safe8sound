import { err, ok, toolError } from '@cold-reserve/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createLambdaHandler, type FunctionUrlEvent } from '../src/lambda.js';
import { readParameter } from '../src/ssm.js';
import { TOKEN, initializeRequest, makeHandler } from './helpers.js';

function event(overrides: Partial<FunctionUrlEvent> = {}): FunctionUrlEvent {
  return {
    rawPath: '/mcp',
    rawQueryString: '',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
      'x-correlation-id': '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60',
    },
    body: JSON.stringify(initializeRequest),
    isBase64Encoded: false,
    requestContext: { domainName: 'abc.lambda-url.us-east-1.on.aws', http: { method: 'POST' } },
    ...overrides,
  };
}

describe('Lambda Function URL entry (same handler as the local Node entry)', () => {
  it('turns the event into a Web Request and the Response back into a result', async () => {
    const lambda = createLambdaHandler(() => Promise.resolve(ok(makeHandler().handler)));
    const result = await lambda(event());
    expect(result.statusCode).toBe(200);
    expect(result.headers['x-correlation-id']).toBe('0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60');
    expect((JSON.parse(result.body) as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-11-25');
  });

  it('decodes a base64 body', async () => {
    const lambda = createLambdaHandler(() => Promise.resolve(ok(makeHandler().handler)));
    const body = Buffer.from(JSON.stringify(initializeRequest)).toString('base64');
    expect((await lambda(event({ body, isBase64Encoded: true }))).statusCode).toBe(200);
  });

  it('keeps GET -> 405 through the adapter', async () => {
    const lambda = createLambdaHandler(() => Promise.resolve(ok(makeHandler().handler)));
    const result = await lambda({ ...event(), requestContext: { domainName: 'x', http: { method: 'GET' } } });
    expect(result.statusCode).toBe(405);
  });

  it('builds the app once per container', async () => {
    const load = vi.fn(() => Promise.resolve(ok(makeHandler().handler)));
    const lambda = createLambdaHandler(load);
    await lambda(event());
    await lambda(event());
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('answers 500 invalid_config when the configuration fails, and retries on the next request', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(err(toolError('invalid_config', 'MCP_CLIENTS is not set.')))
      .mockResolvedValueOnce(ok(makeHandler().handler));
    const lambda = createLambdaHandler(load);
    const failed = await lambda(event());
    expect(failed.statusCode).toBe(500);
    expect(failed.headers['content-type']).toContain('application/problem+json');
    expect(failed.body).not.toContain('MCP_CLIENTS'); // no configuration detail leaks to the caller
    expect((await lambda(event())).statusCode).toBe(200);
  });
});

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

  it('fails with invalid_config on a non-200 answer, without the value', async () => {
    const fetchFn = () => Promise.resolve(new Response('denied', { status: 403 }));
    const result = await readParameter('/p', { fetchFn, sessionToken: 'tok', timeoutMs: 1000 });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });

  it('fails with invalid_config after the explicit timeout', async () => {
    const fetchFn = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    const result = await readParameter('/p', { fetchFn, sessionToken: 'tok', timeoutMs: 20 });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});
