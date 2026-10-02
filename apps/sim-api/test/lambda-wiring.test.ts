import { createHash } from 'node:crypto';
import { err, ok, toolError, type LogEntry, type Result, type ErrorEnvelope } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import type { AgentCoreClientLike } from '../src/adapters/agentcore.js';
import { loadSimApiLambda } from '../src/lambda-wiring.js';
import { memoryQuotaStore } from '../src/quota.js';

// The sim-api Lambda wiring (#17, the sim-api stack): the secrets come from SSM SecureStrings (never from
// plain env), the agent is the AgentCore runtime, the caps live in the shared table. No AWS call here:
// the parameter reader, the AgentCore client and the quota store are stubs.

const CODE = 'judges-demo-code-2026';
const KEY = Buffer.alloc(32, 7).toString('base64url');
const SECRETS: Record<string, string> = {
  '/cold-reserve/dev/sim/demo-codes': `judges:${createHash('sha256').update(CODE).digest('hex')}`,
  '/cold-reserve/dev/sim/token-keys': `k1:${KEY}`,
  '/cold-reserve/dev/sim/mcp-token': 'm'.repeat(40),
};
const ENV = {
  SIM_DEMO_CODES_PARAMETER: '/cold-reserve/dev/sim/demo-codes',
  SIM_TOKEN_KEYS_PARAMETER: '/cold-reserve/dev/sim/token-keys',
  SIM_MCP_TOKEN_PARAMETER: '/cold-reserve/dev/sim/mcp-token',
  SIM_ALLOWED_ORIGINS: 'https://sim.example',
  AGENT_RUNTIME_ARN: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/cold_reserve_dev_agent-AbCdEf1234',
  SIM_AGENT_TIMEOUT_MS: '7500',
  SIM_MCP_URL: 'https://mcp.example/mcp',
  SIM_MCP_TIMEOUT_MS: '3000',
  STATE_TABLE_NAME: 'ColdReserve-dev',
  AWS_REGION: 'us-east-1',
};

function deps(overrides: { read?: (name: string) => Promise<Result<string, ErrorEnvelope>> } = {}) {
  const asked: string[] = [];
  const tables: string[] = [];
  const logs: LogEntry[] = [];
  const agentCore: AgentCoreClientLike = { send: () => Promise.reject(new Error('not called in these tests')) };
  return {
    asked,
    tables,
    logs,
    deps: {
      read:
        overrides.read ??
        ((name: string) => {
          asked.push(name);
          const value = SECRETS[name];
          return Promise.resolve(value === undefined ? err(toolError('invalid_config', `Parameter ${name} was not found.`)) : ok(value));
        }),
      agentCore,
      quotaFor: (table: { tableName: string }) => {
        tables.push(table.tableName);
        return memoryQuotaStore();
      },
      log: (entry: LogEntry) => logs.push(entry),
      clock: { now: () => Date.UTC(2026, 9, 2, 12) },
    },
  };
}

const session = (handler: (req: Request, meta: { clientIp: string }) => Promise<Response>, code: string) =>
  handler(new Request('https://abc.lambda-url.us-east-1.on.aws/v1/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://sim.example' }, body: JSON.stringify({ code }) }), { clientIp: '203.0.113.7' });

describe('loadSimApiLambda', () => {
  it('reads the three secrets from SSM, uses the shared table for the caps, and serves a session with the demo code', async () => {
    const { asked, tables, deps: d } = deps();
    const built = await loadSimApiLambda(ENV, d);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(asked.sort()).toEqual(Object.keys(SECRETS).sort());
    expect(tables).toEqual(['ColdReserve-dev']);
    expect((await session(built.value, CODE)).status).toBe(200);
    expect((await session(built.value, 'a-wrong-demo-code-0000')).status).toBe(401);
  });

  it('never takes a secret from plain env, even when one is there', async () => {
    const { deps: d } = deps();
    const built = await loadSimApiLambda({ ...ENV, SIM_DEMO_CODES: `x:${'0'.repeat(64)}` }, d);
    if (!built.ok) throw new Error('expected ok');
    expect((await session(built.value, CODE)).status).toBe(200);
  });

  it('passes a transient SSM failure on (the Lambda answers 503 and retries the next request)', async () => {
    const { deps: d } = deps({ read: () => Promise.resolve(err(toolError('config_unavailable', 'Parameter timed out.'))) });
    const built = await loadSimApiLambda(ENV, d);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error.code).toBe('config_unavailable');
  });

  it('checks the plain settings (origins, caps, TTL, kill switch) before any SSM read (Copilot on #156)', async () => {
    for (const broken of [{ SIM_ALLOWED_ORIGINS: 'not a url' }, { SIM_ALLOWED_ORIGINS: undefined }, { SIM_LIMIT_TURNS_PER_CODE: 'many' }, { SIM_TOKEN_TTL_S: '5' }, { SIM_DEMO_ENABLED: 'maybe' }]) {
      const { asked, deps: d } = deps();
      const built = await loadSimApiLambda({ ...ENV, ...broken }, d);
      expect(built).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
      expect(asked).toEqual([]);
    }
  });

  it('answers invalid_config naming the setting (never a value) when a setting is missing or malformed', async () => {
    for (const broken of [{ AGENT_RUNTIME_ARN: 'not-an-arn' }, { STATE_TABLE_NAME: undefined }, { SIM_MCP_URL: 'nope' }, { SIM_DEMO_CODES_PARAMETER: undefined }]) {
      const { asked, deps: d } = deps();
      const built = await loadSimApiLambda({ ...ENV, ...broken }, d);
      expect(built.ok).toBe(false);
      if (!built.ok) {
        expect(built.error.code).toBe('invalid_config');
        expect(JSON.stringify(built.error)).toContain(Object.keys(broken)[0]);
      }
      expect(asked).toEqual([]); // nothing is read before the settings are valid
    }
  });

  it('rejects a secret with the wrong shape without echoing it', async () => {
    const { deps: d } = deps({ read: (name) => Promise.resolve(ok(name.endsWith('token-keys') ? 'k1:AAAAAAAA' : (SECRETS[name] ?? ''))) });
    const built = await loadSimApiLambda(ENV, d);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.error.code).toBe('invalid_config');
      expect(built.error.message).not.toContain('AAAAAAAA');
    }
  });

  it('rejects an MCP token shorter than 32 characters', async () => {
    const { deps: d } = deps({ read: (name) => Promise.resolve(ok(name.endsWith('mcp-token') ? 'tiny' : (SECRETS[name] ?? ''))) });
    const built = await loadSimApiLambda(ENV, d);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error.message).not.toContain('tiny');
  });
});
