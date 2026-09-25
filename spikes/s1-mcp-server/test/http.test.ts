import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ORIGIN,
  OTHER_TOKEN,
  PROTOCOL_VERSION,
  TOKEN,
  baseHeaders,
  initializeRequest,
  makeHandler,
  post,
} from './helpers.js';

const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain('application/problem+json');
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ status, code });
  expect(typeof body.title).toBe('string');
  expect(String(body.instance)).toMatch(/^urn:uuid:/);
  return body;
}

describe('HTTP method', () => {
  it('answers GET with 405 and Allow: POST (no SSE stream in stateless mode)', async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request('http://127.0.0.1:3000/mcp', { method: 'GET', headers: baseHeaders() }));
    expect(res.headers.get('allow')).toBe('POST');
    await expectProblem(res, 405, 'method_not_allowed');
  });

  it('answers DELETE with 405 (no session to terminate)', async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request('http://127.0.0.1:3000/mcp', { method: 'DELETE', headers: baseHeaders() }));
    await expectProblem(res, 405, 'method_not_allowed');
  });
});

describe('Origin allowlist', () => {
  it('rejects a foreign Origin with 403', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, initializeRequest, { origin: 'https://evil.example' });
    await expectProblem(res, 403, 'origin_not_allowed');
  });

  it('checks the Origin before the token (403 wins over 401)', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, initializeRequest, { origin: 'https://evil.example', authorization: undefined });
    expect(res.status).toBe(403);
  });

  it('accepts an allowlisted Origin', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, initializeRequest, { origin: ALLOWED_ORIGIN });
    expect(res.status).toBe(200);
  });

  it('accepts a request without Origin (server-to-server clients)', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, initializeRequest, { origin: undefined });
    expect(res.status).toBe(200);
  });
});

describe('Bearer token', () => {
  it('answers 401 with WWW-Authenticate when the token is missing', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, initializeRequest, { authorization: undefined });
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    await expectProblem(res, 401, 'missing_token');
  });

  it('answers 401 invalid_token for a token not issued to any client', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, initializeRequest, { authorization: `Bearer ${OTHER_TOKEN}` });
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
    await expectProblem(res, 401, 'invalid_token');
  });

  it('answers 401 for a non-Bearer scheme', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, initializeRequest, { authorization: `Basic ${TOKEN}` });
    await expectProblem(res, 401, 'missing_token');
  });

  it('never echoes the presented token', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, initializeRequest, { authorization: `Bearer ${OTHER_TOKEN}` });
    expect(await res.text()).not.toContain(OTHER_TOKEN);
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
    const res = await post(handler, toolsList, { 'mcp-protocol-version': '1999-01-01' });
    expect(res.status).toBe(400);
  });

  it('answers 400 to a non-initialize request without the header (strict mode)', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, toolsList, { 'mcp-protocol-version': undefined });
    await expectProblem(res, 400, 'missing_protocol_version');
  });

  it('falls back to the spec default when strict mode is off', async () => {
    const { handler } = makeHandler({ requireProtocolVersionHeader: false });
    const res = await post(handler, toolsList, { 'mcp-protocol-version': undefined });
    expect(res.status).toBe(200);
  });
});

describe('Stateless Streamable HTTP', () => {
  it('answers a notification with 202 and no body', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('answers requests with plain JSON, not SSE, and without a session id', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, initializeRequest);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('serves tools/list without a prior initialize on the same instance', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, toolsList);
    expect(res.status).toBe(200);
  });

  it('answers malformed JSON with a JSON-RPC parse error', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, '{not json');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
});

describe('Correlation id', () => {
  it('echoes a well-formed x-correlation-id', async () => {
    const { handler } = makeHandler();
    const id = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';
    const res = await post(handler, initializeRequest, { 'x-correlation-id': id });
    expect(res.headers.get('x-correlation-id')).toBe(id);
  });

  it('generates one when missing or malformed and uses it as the problem instance', async () => {
    const { handler } = makeHandler();
    const res = await post(handler, initializeRequest, { 'x-correlation-id': 'bad id <script>', authorization: undefined });
    const id = res.headers.get('x-correlation-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const body = (await res.json()) as { instance: string };
    expect(body.instance).toBe(`urn:uuid:${id}`);
  });
});
