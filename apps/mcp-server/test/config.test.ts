import type { LogEntry } from '@cold-reserve/contracts';
import { fixedClock } from '@cold-reserve/core';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
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

  it('marks a family phone client with the phone scope: its token reads the inbox only (#24)', () => {
    const result = loadConfig({ MCP_CLIENTS: `agent@demo=${AGENT}, phone:family@demo=${INSPECTOR}` });
    expect(result.ok && result.value.clients.get(INSPECTOR)).toEqual({ clientId: 'family', homeId: 'demo', scope: 'phone' });
    expect(result.ok && result.value.clients.get(AGENT)).toEqual({ clientId: 'agent', homeId: 'demo' });
  });

  it('keeps the phone scope and the demo sandboxes apart: a phone client names one home (#24, #101)', () => {
    expect(loadConfig({ MCP_CLIENTS: `phone:family@demo#*=${INSPECTOR}` })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    const both = loadConfig({ MCP_CLIENTS: `agent@demo#*=${AGENT}, phone:family@demo=${INSPECTOR}` });
    expect(both.ok && both.value.clients.get(AGENT)).toEqual({ clientId: 'agent', homeId: 'demo', sandboxes: true });
    expect(both.ok && both.value.clients.get(INSPECTOR)).toEqual({ clientId: 'family', homeId: 'demo', scope: 'phone' });
  });

  it('marks the agent and the card actions with their scopes, sandboxes included (#233)', () => {
    const result = loadConfig({ MCP_CLIENTS: `agent:agent@demo#*=${AGENT}, cards:sim@demo#*=${INSPECTOR}` });
    expect(result.ok && result.value.clients.get(AGENT)).toEqual({ clientId: 'agent', homeId: 'demo', sandboxes: true, scope: 'agent' });
    expect(result.ok && result.value.clients.get(INSPECTOR)).toEqual({ clientId: 'sim', homeId: 'demo', sandboxes: true, scope: 'cards' });
  });

  it('refuses an unknown scope', () => {
    expect(loadConfig({ MCP_CLIENTS: `admin:family@demo=${INSPECTOR}` })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
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

describe('sandbox grants (#101): <client>@demo#*', () => {
  const T = 's'.repeat(32);

  it('lets a client serve demo and the demo# sandboxes', () => {
    const result = loadConfig({ MCP_CLIENTS: `agent@demo#*=${T}` });
    expect(result.ok && result.value.clients.get(T)).toEqual({ clientId: 'agent', homeId: 'demo', sandboxes: true });
  });

  it.each(['home#*', 'demo#a*', 'other#*'])('refuses the pattern %s', (pattern) => {
    expect(loadConfig({ MCP_CLIENTS: `agent@${pattern}=${T}` })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});

describe('the client scopes at start-up (#233)', () => {
  it('says once how many grants have each scope and how many have none: counts only, never a client or a token', () => {
    const logs: LogEntry[] = [];
    const clients = `agent:agent@demo#*=${AGENT}, cards:sim@demo#*=${INSPECTOR}, bench@demo=${'c'.repeat(32)}, phone:daughter@demo=${'d'.repeat(32)}`;
    const app = createApp({ MCP_CLIENTS: clients }, { wallClock: fixedClock(Date.UTC(2026, 9, 4, 18)), logger: { log: (e) => logs.push(e) } });
    if (!app.ok) throw new Error(app.error.message);
    const lines = logs.filter((l) => l.details?.['event'] === 'client_scopes');
    expect(lines).toMatchObject([{ level: 'info', correlationId: 'startup', details: { agent: 1, cards: 1, phone: 1, unscoped: 1 } }]);
    expect(JSON.stringify(lines)).not.toMatch(/bench|daughter|aaaa|bbbb/);
  });
});
