import { ProblemDetailsSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ORIGIN,
  HOME_TOKEN,
  OTHER_TOKEN,
  PROTOCOL_VERSION,
  TOKEN,
  URL_MCP,
  baseHeaders,
  callTool,
  initializeRequest,
  makeHandler,
  post,
  toolResult,
  toolsList,
} from './helpers.js';

// Conformance cases of plan §10.3 and spike S1: stateless Streamable HTTP, JSON responses,
// Origin allowlist, bearer token per client, Problem Details for every HTTP error.

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain('application/problem+json');
  const body = ProblemDetailsSchema.parse(await res.json());
  expect(body).toMatchObject({ status, code });
  expect(body.instance).toBe(`urn:uuid:${res.headers.get('x-correlation-id') ?? ''}`);
  return body;
}

describe('HTTP method and path', () => {
  it.each(['GET', 'DELETE', 'PUT'])('answers %s with 405 and Allow: POST (no SSE stream, no session)', async (method) => {
    const { handler } = makeHandler();
    const res = await handler(new Request(URL_MCP, { method, headers: baseHeaders() }));
    expect(res.headers.get('allow')).toBe('POST');
    await expectProblem(res, 405, 'method_not_allowed');
  });

  it('answers an unknown path with 404', async () => {
    const { handler } = makeHandler();
    await expectProblem(await post(handler, initializeRequest, {}, 'http://127.0.0.1:3316/other'), 404, 'route_not_found');
  });

  it('answers a body over the limit with 413 before parsing it', async () => {
    const { handler } = makeHandler({ config: { maxBodyBytes: 100 } });
    await expectProblem(await post(handler, { padding: 'x'.repeat(200) }), 413, 'payload_too_large');
  });
});

describe('Origin allowlist', () => {
  it('rejects a foreign Origin with 403', async () => {
    const { handler } = makeHandler();
    await expectProblem(await post(handler, initializeRequest, { origin: 'https://evil.example' }), 403, 'origin_not_allowed');
  });

  it('checks the Origin before the token (403 wins over 401)', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, initializeRequest, { origin: 'https://evil.example', authorization: undefined });
    expect(res.status).toBe(403);
  });

  it('accepts an allowlisted Origin and a request without Origin (server-to-server)', async () => {
    const { handler } = makeHandler();
    expect((await post(handler, initializeRequest, { origin: ALLOWED_ORIGIN })).status).toBe(200);
    expect((await post(handler, initializeRequest, { origin: undefined })).status).toBe(200);
  });
});

describe('Bearer token per client', () => {
  it('answers 401 missing_token with WWW-Authenticate when there is no token', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, initializeRequest, { authorization: undefined });
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    await expectProblem(res, 401, 'missing_token');
  });

  it('answers 401 missing_token for a non-Bearer scheme', async () => {
    const { handler } = makeHandler();
    await expectProblem(await post(handler, initializeRequest, { authorization: `Basic ${TOKEN}` }), 401, 'missing_token');
  });

  it('answers 401 wrong_client for a token not issued to any client, and logs it without the token', async () => {
    const { handler, logs } = makeHandler();
    const res = await post(handler, initializeRequest, { authorization: `Bearer ${OTHER_TOKEN}` });
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
    const text = JSON.stringify(await expectProblem(res, 401, 'wrong_client'));
    expect(text).not.toContain(OTHER_TOKEN);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ code: 'wrong_client', category: 'unauthorized', component: 'mcp-server' });
    expect(JSON.stringify(logs)).not.toContain(OTHER_TOKEN);
  });

  it('derives the home from the token, never from the request', async () => {
    const { handler } = makeHandler();
    const demo = await toolResult(await post(handler, callTool('whoami', {})));
    expect(demo.structuredContent).toEqual({ clientId: 'agent', homeId: 'demo' });
    const home = await toolResult(await post(handler, callTool('whoami', {}), { authorization: `Bearer ${HOME_TOKEN}` }));
    expect(home.structuredContent).toEqual({ clientId: 'video', homeId: 'home' });
    // A homeId argument is not part of the input: it is rejected, not honoured.
    const spoof = await toolResult(await post(handler, callTool('whoami', { homeId: 'home' })));
    expect(spoof.structuredContent).toMatchObject({ code: 'invalid_input' });
  });
});

describe('MCP-Protocol-Version', () => {
  it('initialize works without the header and negotiates 2025-11-25', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, initializeRequest, { 'mcp-protocol-version': undefined });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('answers 400 to an unsupported version', async () => {
    const { handler } = makeHandler();
    expect((await post(handler, toolsList, { 'mcp-protocol-version': '1999-01-01' })).status).toBe(400);
  });

  it('answers 400 to a non-initialize request without the header (strict mode)', async () => {
    const { handler } = makeHandler();
    await expectProblem(await post(handler, toolsList, { 'mcp-protocol-version': undefined }), 400, 'missing_protocol_version');
  });

  it('falls back to the spec default when strict mode is off', async () => {
    const { handler } = makeHandler({ config: { requireProtocolVersionHeader: false } });
    expect((await post(handler, toolsList, { 'mcp-protocol-version': undefined })).status).toBe(200);
  });
});

describe('Stateless Streamable HTTP', () => {
  it('answers a notification with 202 and no body', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('answers with plain JSON, not SSE, and without a session id', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, initializeRequest);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('serves tools/list without a prior initialize', async () => {
    const { handler } = makeHandler();
    expect((await post(handler, toolsList)).status).toBe(200);
  });

  it('answers malformed JSON with a JSON-RPC parse error', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, '{not json');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });
});

describe('Correlation id', () => {
  it('echoes a well-formed x-correlation-id', async () => {
    const { handler } = makeHandler();
    const id = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';
    expect((await post(handler, initializeRequest, { 'x-correlation-id': id })).headers.get('x-correlation-id')).toBe(id);
  });

  it('generates one when missing or malformed and uses it as the problem instance', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, initializeRequest, { 'x-correlation-id': 'bad id <script>', authorization: undefined });
    expect(res.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    await expectProblem(res, 401, 'missing_token');
  });
});
