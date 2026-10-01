import { HomeIdSchema, err, ok, toolError } from '@cold-reserve/contracts';
import { seededRng } from '@cold-reserve/core';
import { dynamoStateStoreFactory, type TableClient } from '@cold-reserve/store-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { createLambdaHandler, installProcessHooks, storeErrorLine, storeErrorLogger, type FunctionUrlEvent, type LambdaLogEntry } from '../src/lambda.js';
import { readParameter } from '../src/ssm.js';
import { TOKEN, initializeRequest, makeHandler } from './helpers.js';

const ID = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';
const problemOf = (body: string) => JSON.parse(body) as { status: number; code: string; instance: string; detail: string };

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

describe('Lambda last resort (#112): no raw 502, a log line for every failure', () => {
  const capture = () => {
    const logs: LambdaLogEntry[] = [];
    return { logs, log: (entry: LambdaLogEntry) => logs.push(entry) };
  };

  it('does not cache a rejected init: 500 unexpected_error with a log line, then the next request retries', async () => {
    const { logs, log } = capture();
    const load = vi.fn().mockRejectedValueOnce(new TypeError('boom at init')).mockResolvedValueOnce(ok(makeHandler().handler));
    const lambda = createLambdaHandler(load, { log });
    const failed = await lambda(event());
    expect(failed.statusCode).toBe(500);
    expect(failed.headers['content-type']).toContain('application/problem+json');
    expect(problemOf(failed.body)).toMatchObject({ code: 'unexpected_error', instance: `urn:uuid:${ID}` });
    expect(failed.body).not.toContain('boom');
    expect(logs).toMatchObject([{ level: 'error', component: 'mcp-server', code: 'unexpected_error', category: 'internal', correlationId: ID, errorName: 'TypeError' }]);
    expect((await lambda(event())).statusCode).toBe(200);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('maps a throw from the request handler to 500 unexpected_error and keeps the built app', async () => {
    const { logs, log } = capture();
    const load = vi.fn(() => Promise.resolve(ok(() => Promise.reject(new RangeError('handler bug')))));
    const lambda = createLambdaHandler(load, { log });
    const failed = await lambda(event());
    expect(failed.statusCode).toBe(500);
    expect(problemOf(failed.body).code).toBe('unexpected_error');
    expect(failed.headers['x-correlation-id']).toBe(ID);
    expect(logs).toMatchObject([{ code: 'unexpected_error', correlationId: ID, errorName: 'RangeError' }]);
    await lambda(event());
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('maps a bad event (the Request cannot be built) to 500, not a throw', async () => {
    const { logs, log } = capture();
    const lambda = createLambdaHandler(() => Promise.resolve(ok(makeHandler().handler)), { log });
    const failed = await lambda(event({ requestContext: { domainName: 'bad host name', http: { method: 'POST' } } }));
    expect(failed.statusCode).toBe(500);
    expect(logs[0]?.code).toBe('unexpected_error');
  });

  it('logs a configuration failure with the correlation id of the request', async () => {
    const { logs, log } = capture();
    const lambda = createLambdaHandler(() => Promise.resolve(err(toolError('invalid_config', 'MCP_CLIENTS is not set.'))), { log });
    const failed = await lambda(event());
    expect(failed.statusCode).toBe(500);
    expect(logs).toMatchObject([{ level: 'error', code: 'invalid_config', category: 'internal', correlationId: ID }]);
  });

  it('passes a transient dependency failure at init on as 503, retryable, and retries on the next request', async () => {
    const { logs, log } = capture();
    const load = vi
      .fn()
      .mockResolvedValueOnce(err(toolError('config_unavailable', 'Parameter /p could not be read (timed out after 2000 ms).')))
      .mockResolvedValueOnce(ok(makeHandler().handler));
    const lambda = createLambdaHandler(load, { log });
    const failed = await lambda(event());
    expect(failed.statusCode).toBe(503);
    expect(problemOf(failed.body).code).toBe('config_unavailable');
    expect(failed.body).not.toContain('/p');
    expect(logs).toMatchObject([{ level: 'warn', code: 'config_unavailable', category: 'dependency_unavailable', correlationId: ID }]);
    expect((await lambda(event())).statusCode).toBe(200);
  });

  it('generates a correlation id when the header is missing or not a UUID', async () => {
    const { logs, log } = capture();
    const lambda = createLambdaHandler(() => Promise.reject(new Error('x')), { log });
    const failed = await lambda(event({ headers: { 'x-correlation-id': 'not-a-uuid' } }));
    const id = failed.headers['x-correlation-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(logs[0]?.correlationId).toBe(id);
  });
});

describe('process hooks (#112)', () => {
  const fakeProcess = () => {
    const handlers = new Map<string, (value: unknown) => void>();
    return {
      handlers,
      on: (name: 'unhandledRejection' | 'uncaughtException', fn: (value: unknown) => void) => {
        handlers.set(name, fn);
      },
    };
  };

  it('logs an unhandled rejection as unexpected_error, with the error name only', () => {
    const proc = fakeProcess();
    const logs: LambdaLogEntry[] = [];
    installProcessHooks(proc, { log: (e: LambdaLogEntry) => logs.push(e), exit: () => undefined });
    proc.handlers.get('unhandledRejection')?.(new SyntaxError('secret detail'));
    expect(logs).toMatchObject([{ level: 'error', component: 'mcp-server', code: 'unexpected_error', category: 'internal', errorName: 'SyntaxError' }]);
    expect(JSON.stringify(logs)).not.toContain('secret detail');
  });

  it('logs an uncaught exception and then exits with 1, so the runtime starts a clean container', () => {
    const proc = fakeProcess();
    const logs: LambdaLogEntry[] = [];
    const exit = vi.fn();
    installProcessHooks(proc, { log: (e: LambdaLogEntry) => logs.push(e), exit });
    proc.handlers.get('uncaughtException')?.(new Error('x'));
    expect(logs[0]).toMatchObject({ code: 'unexpected_error', errorName: 'Error' });
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('store error log line (#112)', () => {
  it('keeps the SDK error name, HTTP status and request id, never the cause text', () => {
    const cause = Object.assign(new Error('User: arn:aws:sts::123456789012:assumed-role/x is not authorized'), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 400, requestId: 'REQ123' },
    });
    const line = storeErrorLine({ code: 'store_unavailable', operation: 'getPreferences', cause });
    expect(line).toMatchObject({ level: 'warn', component: 'store-dynamodb', code: 'store_unavailable', category: 'dependency_unavailable', operation: 'getPreferences', errorName: 'AccessDeniedException', httpStatus: 400, requestId: 'REQ123' });
    expect(JSON.stringify(line)).not.toContain('arn:aws');
  });

  it('names the correlation id of the request the store was serving (#111)', () => {
    const line = storeErrorLine({ code: 'store_unavailable', operation: 'getPlan', cause: new Error('x'), correlationId: '3f6c1a9e-8b2d-4c7e-9a1f-2b3c4d5e6f70' });
    expect(line.correlationId).toBe('3f6c1a9e-8b2d-4c7e-9a1f-2b3c4d5e6f70');
  });

  it("wired as in lambda-main: a store opened for a request logs its failure with that request's id", async () => {
    const lines: LambdaLogEntry[] = [];
    const down = () => Promise.reject(Object.assign(new Error('slow'), { name: 'ThrottlingException' }));
    const failing: TableClient = { get: down, put: down, update: down, query: down, transactPut: down };
    const factory = dynamoStateStoreFactory({ table: failing, clock: { now: () => 0 }, rng: seededRng(1), onError: storeErrorLogger((l) => lines.push(l)) });
    await factory(HomeIdSchema.parse('demo'), { correlationId: '3f6c1a9e-8b2d-4c7e-9a1f-2b3c4d5e6f70' }).getPreferences();
    expect(lines[0]).toMatchObject({ component: 'store-dynamodb', code: 'store_unavailable', correlationId: '3f6c1a9e-8b2d-4c7e-9a1f-2b3c4d5e6f70' });
  });

  it('copes with a cause that is not an Error', () => {
    expect(storeErrorLine({ code: 'unexpected_error', operation: 'putPlan', cause: 'weird' })).toMatchObject({ level: 'error', category: 'internal', errorName: 'string' });
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

  it('fails with config_unavailable on a 5xx or a network error (transient), invalid_config otherwise', async () => {
    const answer = (status: number) => () => Promise.resolve(new Response('x', { status }));
    expect(await readParameter('/p', { fetchFn: answer(503), sessionToken: 'tok', timeoutMs: 1000 })).toMatchObject({ ok: false, error: { code: 'config_unavailable' } });
    const refused = () => Promise.reject(new TypeError('fetch failed'));
    expect(await readParameter('/p', { fetchFn: refused, sessionToken: 'tok', timeoutMs: 1000 })).toMatchObject({ ok: false, error: { code: 'config_unavailable' } });
    expect(await readParameter('/p', { fetchFn: answer(400), sessionToken: 'tok', timeoutMs: 1000 })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
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
