import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const AGENT = 'a'.repeat(32);
const INSPECTOR = 'b'.repeat(32);

describe('loadConfig', () => {
  it('maps each bearer token to one client and the home it serves', () => {
    const result = loadConfig({
      MCP_CLIENTS: `agent@demo=${AGENT}, inspector@home=${INSPECTOR}`,
      MCP_ALLOWED_ORIGINS: 'http://127.0.0.1:5173, http://localhost:5173',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clients.get(AGENT)).toEqual({ clientId: 'agent', homeId: 'demo' });
    expect(result.value.clients.get(INSPECTOR)).toEqual({ clientId: 'inspector', homeId: 'home' });
    expect(result.value.allowedOrigins).toEqual(['http://127.0.0.1:5173', 'http://localhost:5173']);
    expect(result.value).toMatchObject({ requireProtocolVersionHeader: true, path: '/mcp' });
  });

  it('allows the strict protocol-version check to be switched off', () => {
    const result = loadConfig({ MCP_CLIENTS: `agent@demo=${AGENT}`, MCP_REQUIRE_PROTOCOL_VERSION: 'false' });
    expect(result.ok && result.value.requireProtocolVersionHeader).toBe(false);
  });

  it.each([
    ['no clients', {}],
    ['a malformed entry', { MCP_CLIENTS: `agent${AGENT}` }],
    ['a missing home', { MCP_CLIENTS: `agent=${AGENT}` }],
    ['an invalid home id', { MCP_CLIENTS: `agent@Home Sweet=${AGENT}` }],
    ['a token shorter than 32 characters', { MCP_CLIENTS: 'agent@demo=short' }],
    ['two clients sharing a token', { MCP_CLIENTS: `agent@demo=${AGENT},inspector@demo=${AGENT}` }],
    ['the same client twice', { MCP_CLIENTS: `agent@demo=${AGENT},agent@home=${INSPECTOR}` }],
    ['a non-numeric body limit', { MCP_CLIENTS: `agent@demo=${AGENT}`, MCP_MAX_BODY_BYTES: 'lots' }],
  ])('fails with invalid_config on %s', (_name, env) => {
    expect(loadConfig(env)).toMatchObject({ ok: false, error: { code: 'invalid_config', category: 'internal' } });
  });

  it('never echoes a token in the error message', () => {
    const result = loadConfig({ MCP_CLIENTS: 'agent@demo=tooshort-secret' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).not.toContain('tooshort-secret');
  });
});
