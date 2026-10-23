import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { siteTimingEnv } from '../scripts/turn-timing.js';
import { parseConfig } from '../src/config.js';

// #270: the browser's waits come from the one timing table in infra/cdk.json, in the AWS build and as local defaults.

const cdk: unknown = JSON.parse(readFileSync(new URL('../../../infra/cdk.json', import.meta.url), 'utf8'));

describe('the browser waits from the timing table (#270)', () => {
  it('the AWS build sets both waits from cdk.json', () => {
    expect(siteTimingEnv(cdk)).toEqual({ VITE_AGENT_TIMEOUT_MS: '24000', VITE_TURN_BUDGET_MS: '26000' });
  });

  it('refuses a cdk.json without the table, rather than building with a guess', () => {
    expect(() => siteTimingEnv({ context: {} })).toThrow(/turnTiming/);
  });

  it('the local defaults are the table values', () => {
    const parsed = parseConfig({}, '', false);
    const env = siteTimingEnv(cdk);
    expect(parsed.ok && [parsed.value.agentTimeoutMs, parsed.value.turnBudgetMs]).toEqual([Number(env.VITE_AGENT_TIMEOUT_MS), Number(env.VITE_TURN_BUDGET_MS)]);
  });
});
