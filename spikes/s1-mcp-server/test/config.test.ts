import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const AGENT = 'a'.repeat(32);
const INSPECTOR = 'b'.repeat(32);

describe('loadConfig', () => {
  it('parses one bearer token per client and the Origin allowlist', () => {
    const result = loadConfig({
      MCP_CLIENT_TOKENS: `agent=${AGENT},inspector=${INSPECTOR}`,
      MCP_ALLOWED_ORIGINS: 'http://127.0.0.1:5173, http://localhost:5173',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clientTokens.get(AGENT)).toBe('agent');
    expect(result.value.clientTokens.get(INSPECTOR)).toBe('inspector');
    expect(result.value.allowedOrigins).toEqual(['http://127.0.0.1:5173', 'http://localhost:5173']);
    expect(result.value.requireProtocolVersionHeader).toBe(true);
  });

  it('allows the strict protocol-version check to be switched off', () => {
    const result = loadConfig({ MCP_CLIENT_TOKENS: `agent=${AGENT}`, MCP_REQUIRE_PROTOCOL_VERSION: 'false' });
    expect(result.ok && result.value.requireProtocolVersionHeader).toBe(false);
  });

  it('fails with missing_client_tokens when no token is configured', () => {
    const result = loadConfig({});
    expect(result).toMatchObject({ ok: false, error: { code: 'missing_client_tokens' } });
  });

  it('fails with invalid_client_tokens on a malformed pair', () => {
    const result = loadConfig({ MCP_CLIENT_TOKENS: `agent${AGENT}` });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_client_tokens' } });
  });

  it('fails with invalid_client_tokens on a token shorter than 32 characters', () => {
    const result = loadConfig({ MCP_CLIENT_TOKENS: 'agent=short' });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_client_tokens' } });
  });

  it('fails with invalid_client_tokens when two clients share a token', () => {
    const result = loadConfig({ MCP_CLIENT_TOKENS: `agent=${AGENT},inspector=${AGENT}` });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_client_tokens' } });
  });

  it('never echoes a token in the error message', () => {
    const result = loadConfig({ MCP_CLIENT_TOKENS: 'agent=tooshort-secret' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).not.toContain('tooshort-secret');
  });
});
