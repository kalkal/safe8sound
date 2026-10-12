import { HomeIdSchema } from '@cold-reserve/contracts';
import { fixedClock } from '@cold-reserve/core';
import { demoProfile } from '@cold-reserve/source-simulator';
import { dynamoStateStoreFactory, type TableClient } from '@cold-reserve/store-dynamodb';
import { describe, expect, it } from 'vitest';
import { comfortPlanWiring } from '../src/comfort-plan-config.js';
import { storeErrorLogger, toLogEntry, type LambdaLogEntry } from '../src/lambda.js';
import { loadPreferencesConfig, preferencesConfigFile } from '../src/preferences-config.js';
import { stormModeWiring } from '../src/storm-mode-config.js';
import { quietNotifier } from './helpers.js';

// #354 review: a preferences read that fails logs the store's line with the turn's correlation id, so the
// tool's own line (storm_read_degraded, the plan's error) and the cause's name join on one id end to end.

const clock = fixedClock(Date.parse('2026-09-30T10:00:00Z'));
const TURN = '7d3c1f9e-2b4a-4c8d-9e1f-0a2b3c4d5e6f';
const throttled = Object.assign(new Error('ProvisionedThroughputExceededException'), { name: 'ProvisionedThroughputExceededException', $metadata: { httpStatusCode: 400 } });
const down: TableClient = {
  get: () => Promise.reject(throttled),
  put: () => Promise.reject(throttled),
  update: () => Promise.reject(throttled),
  query: () => Promise.reject(throttled),
  transactPut: () => Promise.reject(throttled),
};

function setup() {
  const lines: LambdaLogEntry[] = [];
  const storeFor = dynamoStateStoreFactory({ table: down, clock, rng: { next: Math.random }, onError: storeErrorLogger((l) => lines.push(l)) });
  const preferences = loadPreferencesConfig(preferencesConfigFile());
  if (!preferences.ok) throw new Error(preferences.error.message);
  return { lines, storeFor, preferences: preferences.value };
}

describe('preferencesFor carries the turn correlation id to the store (#354 review)', () => {
  const demo = HomeIdSchema.parse('demo');

  it('storm mode: the failing read is logged with the turn id', async () => {
    const { lines, storeFor, preferences } = setup();
    const w = stormModeWiring({ storeFor, preferences, clock });
    if (!w.ok) throw new Error(w.error.message);
    expect(await w.value.preferencesFor(demo, demoProfile(), { correlationId: TURN })).toMatchObject({ ok: false });
    expect(lines.map((l) => toLogEntry(l))).toMatchObject([{ component: 'store-dynamodb', correlationId: TURN, errorName: 'ProvisionedThroughputExceededException', details: { operation: 'getPreferences' } }]);
  });

  it('comfort plan: the failing read is logged with the turn id', async () => {
    const { lines, storeFor, preferences } = setup();
    const w = comfortPlanWiring({ storeFor, preferences, clock, notifier: quietNotifier });
    if (!w.ok) throw new Error(w.error.message);
    expect(await w.value.preferencesFor(demo, demoProfile(), { correlationId: TURN })).toMatchObject({ ok: false });
    expect(lines.map((l) => toLogEntry(l))).toMatchObject([{ component: 'store-dynamodb', correlationId: TURN, errorName: 'ProvisionedThroughputExceededException', details: { operation: 'getPreferences' } }]);
  });
});
