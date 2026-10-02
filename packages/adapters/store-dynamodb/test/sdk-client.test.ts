import { describe, expect, it } from 'vitest';
import { defaultDynamoClient, dynamoSettingsFrom, sdkDocumentSender, type DynamoClientSettings } from '../src/index.js';

// One place reads the table settings from env and builds the SDK client, for every Lambda that uses the
// shared table (mcp-server, sim-api). Nothing here calls AWS.

describe('dynamoSettingsFrom', () => {
  const env = { STATE_TABLE_NAME: 'ColdReserve-dev', AWS_REGION: 'us-east-1' };

  it('reads the table, the region and the default timeouts and attempts', () => {
    expect(dynamoSettingsFrom(env)).toEqual({
      ok: true,
      value: { tableName: 'ColdReserve-dev', client: { region: 'us-east-1', connectionTimeoutMs: 500, requestTimeoutMs: 1500, maxAttempts: 3 } },
    });
  });

  it('reads explicit timeouts from the env names the CDK stacks set', () => {
    const tuned = { ...env, STATE_STORE_CONNECT_TIMEOUT_MS: '400', STATE_STORE_REQUEST_TIMEOUT_MS: '2500', STATE_STORE_MAX_ATTEMPTS: '2' };
    const settings = dynamoSettingsFrom(tuned);
    expect(settings.ok && settings.value.client).toEqual({ region: 'us-east-1', connectionTimeoutMs: 400, requestTimeoutMs: 2500, maxAttempts: 2 });
  });

  it('answers invalid_config for a missing table or region, or a bad number', () => {
    for (const bad of [{ AWS_REGION: 'us-east-1' }, { STATE_TABLE_NAME: 'ColdReserve-dev' }, { ...env, STATE_STORE_REQUEST_TIMEOUT_MS: 'soon' }, { ...env, STATE_STORE_CONNECT_TIMEOUT_MS: '-1' }, { ...env, STATE_STORE_MAX_ATTEMPTS: '0' }]) {
      expect(dynamoSettingsFrom(bad)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    }
  });
});

describe('defaultDynamoClient', () => {
  it('builds the SDK client with the given region, without calling AWS', async () => {
    const settings: DynamoClientSettings = { region: 'eu-south-1', connectionTimeoutMs: 500, requestTimeoutMs: 1500, maxAttempts: 3 };
    const client = defaultDynamoClient(settings);
    expect(await client.config.region()).toBe('eu-south-1');
    expect(await client.config.maxAttempts()).toBe(3);
  });
});

describe('sdkDocumentSender', () => {
  it('wraps a real SDK document client as a sender, without calling AWS', () => {
    expect(typeof sdkDocumentSender({ region: 'eu-south-1', connectionTimeoutMs: 500, requestTimeoutMs: 1500, maxAttempts: 3 }).send).toBe('function');
  });
});
