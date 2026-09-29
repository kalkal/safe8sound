import { celsius } from '@cold-reserve/contracts';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { describe, expect, it } from 'vitest';
import { composeModules, createDynamoStoreFactory, defaultDynamoClient, type DynamoClientSettings } from '../src/compose.js';
import { loadPreferencesConfig, preferencesConfigFile } from '../src/preferences-config.js';
import { homeId } from './helpers.js';

const clock = { now: () => Date.parse('2026-07-15T12:00:00Z') };
const config = () => {
  const r = loadPreferencesConfig(preferencesConfigFile());
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe('composeModules (shared by the local and the Lambda entry)', () => {
  it('serves the preferences module to the demo home and to visitor sandboxes', () => {
    const result = composeModules({ preferences: config(), storeFor: memoryStateStoreFactory({ backing: createMemoryBacking(), clock }), clock });
    if (!result.ok) throw new Error(result.error.message);
    const [prefs] = result.value;
    expect(prefs?.id).toBe('preferences');
    expect(prefs?.enabledFor?.(homeId('demo'))).toBe(true);
    expect(prefs?.enabledFor?.(homeId('demo#k3v9x2p7q1'))).toBe(true);
  });

  it('keeps preferences off for the real home until its profile exists (no guessed rooms)', () => {
    const result = composeModules({ preferences: config(), storeFor: memoryStateStoreFactory({ backing: createMemoryBacking(), clock }), clock });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value[0]?.enabledFor?.(homeId('home'))).toBe(false);
  });

  it('stops at startup with invalid_config when the defaults do not fit the demo home', () => {
    const c = config();
    const result = composeModules({
      preferences: { ...c, comfortC: { ...c.comfortC, cooling: celsius(29) } },
      storeFor: memoryStateStoreFactory({ backing: createMemoryBacking(), clock }),
      clock,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});

describe('createDynamoStoreFactory (Lambda)', () => {
  const env = { STATE_TABLE_NAME: 'ColdReserve-dev', AWS_REGION: 'us-east-1' };

  it('builds a DynamoDB-backed store factory without calling AWS', () => {
    expect(createDynamoStoreFactory(env, { clock }).ok).toBe(true);
  });

  it('requires STATE_TABLE_NAME and AWS_REGION', () => {
    expect(createDynamoStoreFactory({ AWS_REGION: 'us-east-1' }, { clock })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(createDynamoStoreFactory({ STATE_TABLE_NAME: 'ColdReserve-dev' }, { clock })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });

  it('gives the SDK client the region, the default timeouts and attempts', () => {
    const seen: DynamoClientSettings[] = [];
    expect(createDynamoStoreFactory(env, { clock, buildClient: (s) => (seen.push(s), defaultDynamoClient(s)) }).ok).toBe(true);
    expect(seen).toEqual([{ region: 'us-east-1', connectionTimeoutMs: 500, requestTimeoutMs: 1500, maxAttempts: 3 }]);
  });

  it('reads explicit SDK timeouts from the env names the CDK stack sets, and refuses bad ones', () => {
    const tuned = { ...env, STATE_STORE_CONNECT_TIMEOUT_MS: '400', STATE_STORE_REQUEST_TIMEOUT_MS: '2500', STATE_STORE_MAX_ATTEMPTS: '2' };
    const seen: DynamoClientSettings[] = [];
    expect(createDynamoStoreFactory(tuned, { clock, buildClient: (s) => (seen.push(s), defaultDynamoClient(s)) }).ok).toBe(true);
    expect(seen).toEqual([{ region: 'us-east-1', connectionTimeoutMs: 400, requestTimeoutMs: 2500, maxAttempts: 2 }]);
    expect(createDynamoStoreFactory({ ...env, STATE_STORE_REQUEST_TIMEOUT_MS: 'soon' }, { clock })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(createDynamoStoreFactory({ ...env, STATE_STORE_CONNECT_TIMEOUT_MS: '-1' }, { clock })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(createDynamoStoreFactory({ ...env, STATE_STORE_MAX_ATTEMPTS: '0' }, { clock })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});
