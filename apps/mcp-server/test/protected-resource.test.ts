import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
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

describe('protected resource config', () => {
  const clients = `agent@demo=${'a'.repeat(32)}`;

  it('reads the canonical URL and the authorization servers from env', () => {
    const c = loadConfig({ MCP_CLIENTS: clients, MCP_RESOURCE_URL: RESOURCE, MCP_AUTHORIZATION_SERVERS: 'https://a.test, https://b.test' });
    expect(c.ok && c.value.protectedResource).toEqual({ resource: RESOURCE, authorizationServers: ['https://a.test', 'https://b.test'] });
    const plain = loadConfig({ MCP_CLIENTS: clients });
    expect(plain.ok && plain.value.protectedResource).toBeUndefined();
  });

  it('refuses a canonical URL that is not https (except a local one) or that does not end with the MCP path', () => {
    expect(loadConfig({ MCP_CLIENTS: clients, MCP_RESOURCE_URL: 'http://mcp.example.test/mcp' }).ok).toBe(false);
    expect(loadConfig({ MCP_CLIENTS: clients, MCP_RESOURCE_URL: 'https://mcp.example.test/other' }).ok).toBe(false);
    expect(loadConfig({ MCP_CLIENTS: clients, MCP_RESOURCE_URL: 'http://127.0.0.1:3316/mcp' }).ok).toBe(true);
    expect(loadConfig({ MCP_CLIENTS: clients, MCP_RESOURCE_URL: RESOURCE, MCP_AUTHORIZATION_SERVERS: 'not a url' }).ok).toBe(false);
  });
});
