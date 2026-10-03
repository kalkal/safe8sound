import { LogEntrySchema, ProblemDetailsSchema, err, ok, toolError, type LogEntry } from '@cold-reserve/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { SimApiHandler } from '../src/handler.js';
import { createSimApiLambda, type FunctionUrlEvent } from '../src/lambda.js';

// The sim-api Lambda entry (#17, the sim-api stack): the same Web handler as the local entry behind a
// Function URL. The client IP is the one AWS saw (requestContext.http.sourceIp), never a header the
// caller writes; nothing escapes as a raw 502.

const ID = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';

function event(overrides: Partial<FunctionUrlEvent> = {}): FunctionUrlEvent {
  return {
    rawPath: '/v1/turns',
    rawQueryString: '',
    headers: { 'content-type': 'application/json', 'x-correlation-id': ID, 'x-forwarded-for': '198.51.100.66', origin: 'https://sim.example' },
    body: JSON.stringify({ question: 'Hi' }),
    isBase64Encoded: false,
    requestContext: { domainName: 'abc.lambda-url.us-east-1.on.aws', http: { method: 'POST', sourceIp: '203.0.113.7' } },
    ...overrides,
  };
}

function capture() {
  const logs: LogEntry[] = [];
  return { logs, log: (entry: LogEntry) => logs.push(entry) };
}

describe('createSimApiLambda', () => {
  it('hands the request to the handler with the client IP AWS saw, never X-Forwarded-For, and returns its response', async () => {
    const seen: { url: string; method: string; body: string; ip: string }[] = [];
    const handler: SimApiHandler = async (req, meta) => {
      seen.push({ url: req.url, method: req.method, body: await req.text(), ip: meta.clientIp });
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200, headers: { 'content-type': 'application/json', 'x-correlation-id': ID } });
    };
    const lambda = createSimApiLambda(() => Promise.resolve(ok(handler)), capture());
    const result = await lambda(event());
    expect(seen).toEqual([{ url: 'https://abc.lambda-url.us-east-1.on.aws/v1/turns', method: 'POST', body: '{"question":"Hi"}', ip: '203.0.113.7' }]);
    expect(result).toMatchObject({ statusCode: 200, headers: { 'content-type': 'application/json', 'x-correlation-id': ID }, body: '{"text":"ok"}' });
  });

  it('decodes a base64 body', async () => {
    let got = '';
    const handler: SimApiHandler = async (req) => {
      got = await req.text();
      return new Response('{}');
    };
    await createSimApiLambda(() => Promise.resolve(ok(handler)), capture())(event({ body: Buffer.from('{"code":"x"}').toString('base64'), isBase64Encoded: true }));
    expect(got).toBe('{"code":"x"}');
  });

  it('does not cache a rejected start: 500 unexpected_error with a log line, then the next request retries', async () => {
    const { logs, log } = capture();
    const load = vi.fn().mockRejectedValueOnce(new TypeError('boom')).mockResolvedValueOnce(ok(() => Promise.resolve(new Response('{}'))));
    const lambda = createSimApiLambda(load, { log });
    const failed = await lambda(event());
    expect(failed.statusCode).toBe(500);
    expect(ProblemDetailsSchema.parse(JSON.parse(failed.body))).toMatchObject({ code: 'unexpected_error', instance: `urn:uuid:${ID}` });
    expect(failed.body).not.toContain('boom');
    expect(logs).toMatchObject([{ level: 'error', component: 'sim-api', code: 'unexpected_error', correlationId: ID, errorName: 'TypeError' }]);
    expect((await lambda(event())).statusCode).toBe(200);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('maps a throw from the handler to 500 unexpected_error, logged, and keeps the built handler', async () => {
    const { logs, log } = capture();
    const load = vi.fn(() => Promise.resolve(ok<SimApiHandler>(() => Promise.reject(new RangeError('bug')))));
    const lambda = createSimApiLambda(load, { log });
    expect((await lambda(event())).statusCode).toBe(500);
    await lambda(event());
    expect(load).toHaveBeenCalledTimes(1);
    expect(logs[0]).toMatchObject({ code: 'unexpected_error', errorName: 'RangeError' });
  });

  it('answers a transient startup failure (SSM) as 503 with its code, and a broken config as a generic 500, the detail only in the log', async () => {
    const { logs, log } = capture();
    const transient = await createSimApiLambda(() => Promise.resolve(err(toolError('config_unavailable', 'Parameter /x timed out.'))), { log })(event());
    expect(transient.statusCode).toBe(503);
    expect(ProblemDetailsSchema.parse(JSON.parse(transient.body)).code).toBe('config_unavailable');
    const broken = await createSimApiLambda(() => Promise.resolve(err(toolError('invalid_config', 'SIM_TOKEN_KEYS is missing.'))), { log })(event());
    expect(broken.statusCode).toBe(500);
    expect(broken.body).not.toContain('SIM_TOKEN_KEYS');
    for (const line of logs) expect(LogEntrySchema.safeParse(line).success).toBe(true);
  });
});

describe('createSimApiLambda: the wait time of a transient startup failure (Copilot on #156)', () => {
  it('keeps retryAfterMs when it rebuilds the transient error for the caller', async () => {
    const { log } = capture();
    const failed = await createSimApiLambda(() => Promise.resolve(err(toolError('config_unavailable', 'Parameter /x is starting.', { retryAfterMs: 1000 }))), { log })(event());
    expect(failed.statusCode).toBe(503);
    expect(ProblemDetailsSchema.parse(JSON.parse(failed.body))).toMatchObject({ code: 'config_unavailable', retryAfterMs: 1000 });
    expect(failed.body).not.toContain('/x');
  });
});

describe('createSimApiLambda: binary answers (review of #180)', () => {
  it('sends a non-text body (the spoken reply) base64 encoded, and its bytes come back identical', async () => {
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x80, 0xc3, 0x28]); // not valid UTF-8 on purpose
    const handler: SimApiHandler = () => Promise.resolve(new Response(audio, { headers: { 'content-type': 'audio/mpeg' } }));
    const result = await createSimApiLambda(() => Promise.resolve(ok(handler)), capture())(event());
    expect(result.isBase64Encoded).toBe(true);
    expect(new Uint8Array(Buffer.from(result.body, 'base64'))).toEqual(audio);
    expect(result.headers['content-type']).toBe('audio/mpeg');
  });

  it('keeps JSON and Problem Details as plain text', async () => {
    const handler: SimApiHandler = () => Promise.resolve(new Response('{"text":"ok"}', { headers: { 'content-type': 'application/json' } }));
    const result = await createSimApiLambda(() => Promise.resolve(ok(handler)), capture())(event());
    expect(result).toMatchObject({ isBase64Encoded: false, body: '{"text":"ok"}' });
  });
});
