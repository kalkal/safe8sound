import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadSimApiConfig } from '../src/config.js';

const CODE = 'judges-demo-code-2026';
const HASH = createHash('sha256').update(CODE).digest('hex');
const KEY = Buffer.alloc(32, 7).toString('base64url');
const ENV = { SIM_DEMO_CODES: `judges:${HASH}`, SIM_TOKEN_KEYS: `k1:${KEY}`, SIM_ALLOWED_ORIGINS: 'http://127.0.0.1:5400' };

describe('loadSimApiConfig (only hashes of codes and key ids reach logs; values come from .env or SSM)', () => {
  it('reads codes by hash, signing keys by kid, and the defaults of the plan', () => {
    const result = loadSimApiConfig(ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.demoCodes.get(HASH)).toBe('judges');
    expect(result.value.keys.map((k) => k.kid)).toEqual(['k1']);
    expect(result.value).toMatchObject({
      tokenTtlS: 3600,
      skewS: 30,
      allowedOrigins: ['http://127.0.0.1:5400'],
      demoEnabled: true,
      limits: { turnsPerCodePerDay: 20, turnsGlobalPerDay: 30, toolCallsPerCodePerDay: 20, codeAttemptsPerIpPerHour: 10 },
    });
  });

  it('takes only true or false for the kill switch (unset = on): a typo is invalid_config, never a silently open demo', () => {
    expect(loadSimApiConfig({ ...ENV, SIM_DEMO_ENABLED: 'true' })).toMatchObject({ ok: true, value: { demoEnabled: true } });
    for (const value of ['maybe', 'off', '0']) expect(loadSimApiConfig({ ...ENV, SIM_DEMO_ENABLED: value })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });

  it('switches the demo off with SIM_DEMO_ENABLED=false (kill switch)', () => {
    expect(loadSimApiConfig({ ...ENV, SIM_DEMO_ENABLED: 'false' })).toMatchObject({ ok: true, value: { demoEnabled: false } });
  });

  it.each([
    ['no demo codes', { ...ENV, SIM_DEMO_CODES: '' }],
    ['a code that is not a sha256 hash', { ...ENV, SIM_DEMO_CODES: `judges:${CODE}` }],
    ['no signing key', { ...ENV, SIM_TOKEN_KEYS: '' }],
    ['a key shorter than 32 bytes', { ...ENV, SIM_TOKEN_KEYS: `k1:${Buffer.alloc(16).toString('base64url')}` }],
    ['a key without a kid', { ...ENV, SIM_TOKEN_KEYS: KEY }],
    ['two keys with the same kid', { ...ENV, SIM_TOKEN_KEYS: `k1:${KEY},k1:${KEY}` }],
    ['no allowed origin', { ...ENV, SIM_ALLOWED_ORIGINS: '' }],
    ['a non-numeric limit', { ...ENV, SIM_LIMIT_TURNS_PER_CODE: 'many' }],
    ['a token lifetime over one hour', { ...ENV, SIM_TOKEN_TTL_S: '7200' }],
  ])('fails with invalid_config on %s, without echoing secrets', (_name, env) => {
    const result = loadSimApiConfig(env);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});
