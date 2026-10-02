import { describe, expect, it } from 'vitest';
import { ok } from '@cold-reserve/contracts';
import { fixedClock } from '@cold-reserve/core';
import { createApp } from '../src/app.js';
import { forLocalEntry, loadConfig } from '../src/config.js';
import type { LogEntry } from '../src/handler.js';
import { createLambdaHandler } from '../src/lambda.js';
import { initializeRequest, makeHandler, post } from './helpers.js';

// G4 step 1: the OAuth 2.0 Protected Resource Metadata document (RFC 9728) at the well-known path of the MCP
// endpoint. Alexa does not read WWW-Authenticate on a 401, so this path is how it finds out how to authenticate.
// Public metadata: no token needed. An authorization server is listed only when one is configured.

const PRM = 'http://127.0.0.1:3316/.well-known/oauth-protected-resource/mcp';
const RESOURCE = 'https://mcp.example.test/mcp';
const configured = { protectedResource: { resource: RESOURCE, authorizationServers: ['https://auth.example.test'] } };
const get = (handler: (r: Request) => Promise<Response>, url = PRM, method = 'GET') => handler(new Request(url, { method }));

describe('protected resource metadata (#149)', () => {
  it('serves the document at the well-known path of the MCP endpoint, without a token', async () => {
    const { handler } = makeHandler({ config: configured });
    const res = await get(handler);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: ['https://auth.example.test'],
      bearer_methods_supported: ['header'],
    });
  });

  it('lists no authorization server when none is configured (today the server takes per-client bearer tokens)', async () => {
    const { handler } = makeHandler({ config: { protectedResource: { resource: RESOURCE, authorizationServers: [] } } });
    expect(await (await get(handler)).json()).toEqual({ resource: RESOURCE, bearer_methods_supported: ['header'] });
  });

  it('is not there when the server has no canonical URL configured', async () => {
    const { handler } = makeHandler();
    expect((await get(handler)).status).toBe(404);
  });

  it('answers GET only', async () => {
    const { handler } = makeHandler({ config: configured });
    const res = await get(handler, PRM, 'POST');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('a 401 names the document, for the clients that do read WWW-Authenticate', async () => {
    const { handler } = makeHandler({ config: configured });
    const res = await post(handler, initializeRequest, { authorization: undefined });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer realm="mcp", resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"`);
  });
});

describe('protected resource metadata in auto mode (#149, Lambda)', () => {
  const auto = { protectedResource: { resource: 'auto' as const, authorizationServers: [] } };
  const LAMBDA = 'https://abc123.lambda-url.eu-south-1.on.aws';

  it('names the resource after the host the request reached, plus the MCP path', async () => {
    const { handler } = makeHandler({ config: auto });
    const res = await get(handler, `${LAMBDA}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resource: `${LAMBDA}/mcp`, bearer_methods_supported: ['header'] });
  });

  it('the 401 challenge names the document on the same host', async () => {
    const { handler } = makeHandler({ config: auto });
    const res = await post(handler, initializeRequest, { authorization: undefined }, `${LAMBDA}/mcp`);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer realm="mcp", resource_metadata="${LAMBDA}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('through the Lambda entry, the host is the Function URL domain AWS puts in the event', async () => {
    const lambda = createLambdaHandler(() => Promise.resolve(ok(makeHandler({ config: auto }).handler)));
    const result = await lambda({
      rawPath: '/.well-known/oauth-protected-resource/mcp',
      rawQueryString: '',
      // Headers a caller controls never move the canonical URL: only the domain AWS puts in the event does.
      headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', forwarded: 'host=evil.example' },
      requestContext: { domainName: 'abc123.lambda-url.eu-south-1.on.aws', http: { method: 'GET' } },
      isBase64Encoded: false,
    });
    expect(result.statusCode).toBe(200);
    expect((JSON.parse(result.body) as { resource: string }).resource).toBe(`${LAMBDA}/mcp`);
  });
});

describe('protected resource config', () => {
  const clients = `agent@demo=${'a'.repeat(32)}`;

  it('reads the canonical URL and the authorization servers from env', () => {
    const c = loadConfig({ MCP_CLIENTS: clients, MCP_RESOURCE_URL: RESOURCE, MCP_AUTHORIZATION_SERVERS: 'https://a.test, https://b.test' });
    expect(c.ok && c.value.protectedResource).toEqual({ resource: RESOURCE, authorizationServers: ['https://a.test', 'https://b.test'] });
    const plain = loadConfig({ MCP_CLIENTS: clients });
    expect(plain.ok && plain.value.protectedResource).toBeUndefined();
  });

  it('refuses "auto" on the local Node entry: it is for Lambda only, where AWS sets the domain (#149)', () => {
    const c = loadConfig({ MCP_CLIENTS: clients, MCP_RESOURCE_URL: 'auto' });
    if (!c.ok) throw new Error(c.error.message);
    const local = forLocalEntry(c.value);
    expect(!local.ok && local.error).toMatchObject({ code: 'invalid_config' });
    expect(!local.ok && local.error.message).toMatch(/MCP_RESOURCE_URL=auto.*Lambda/);
    const fixed = loadConfig({ MCP_CLIENTS: clients, MCP_RESOURCE_URL: 'http://127.0.0.1:3316/mcp' });
    expect(fixed.ok && forLocalEntry(fixed.value).ok).toBe(true);
  });

  it('takes "auto": the canonical URL comes from each request', () => {
    const c = loadConfig({ MCP_CLIENTS: clients, MCP_RESOURCE_URL: 'auto' });
    expect(c.ok && c.value.protectedResource).toEqual({ resource: 'auto', authorizationServers: [] });
  });

  it('refuses a canonical URL that is not https (except a local one) or that does not end with the MCP path', () => {
    expect(loadConfig({ MCP_CLIENTS: clients, MCP_RESOURCE_URL: 'http://mcp.example.test/mcp' }).ok).toBe(false);
    expect(loadConfig({ MCP_CLIENTS: clients, MCP_RESOURCE_URL: 'https://mcp.example.test/other' }).ok).toBe(false);
    expect(loadConfig({ MCP_CLIENTS: clients, MCP_RESOURCE_URL: 'http://127.0.0.1:3316/mcp' }).ok).toBe(true);
    expect(loadConfig({ MCP_CLIENTS: clients, MCP_RESOURCE_URL: RESOURCE, MCP_AUTHORIZATION_SERVERS: 'not a url' }).ok).toBe(false);
  });
});

describe('the metadata mode at start-up (#149)', () => {
  const start = (env: Record<string, string>) => {
    const logs: LogEntry[] = [];
    const app = createApp({ MCP_CLIENTS: `agent@demo=${'a'.repeat(32)}`, ...env }, { wallClock: fixedClock(Date.UTC(2026, 9, 2, 18)), logger: { log: (e) => logs.push(e) } });
    if (!app.ok) throw new Error(app.error.message);
    return logs.filter((l) => l.details?.['event'] === 'protected_resource_metadata');
  };

  it('says the mode once (auto, fixed or off), never the URL itself', () => {
    expect(start({ MCP_RESOURCE_URL: 'auto' })).toMatchObject([{ level: 'info', details: { mode: 'auto' } }]);
    const fixed = start({ MCP_RESOURCE_URL: RESOURCE });
    expect(fixed).toMatchObject([{ level: 'info', details: { mode: 'fixed', authorizationServers: 0 } }]);
    expect(JSON.stringify(fixed)).not.toContain('example.test');
    expect(start({})).toMatchObject([{ details: { mode: 'off' } }]);
  });
});
