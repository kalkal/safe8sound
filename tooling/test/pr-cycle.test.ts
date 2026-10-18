import { describe, expect, it } from 'vitest';
import { crossProcessTests, planCheck } from '../src/check-changed.mjs';
import { planE2e } from '../src/e2e-changed.mjs';
import { workersFor } from '../src/heavy-lock.mjs';

// The PR cycle, optimised without cutting (owner, 18 Oct): Tier A runs on what a PR changes, the full check when it
// touches what everything depends on; heavy steps pick their workers from the free memory.

const GB = 1024 ** 3;

describe('check:changed', () => {
  it('runs the changed tests for a change inside one app or adapter', () => {
    expect(planCheck(['apps/mcp-server/src/modules/storm-mode/summaries.ts', 'apps/mcp-server/test/storm-mode/summaries.test.ts'])).toEqual({ full: false });
    expect(planCheck(['apps/alexa-sim/src/ui/AnswerCard.tsx', 'e2e/site/journeys/user.journey.spec.ts', 'docs/outcomes.md'])).toEqual({ full: false });
  });

  it.each([
    'packages/contracts/src/turn.ts',
    'packages/core/src/simulation.ts',
    'packages/guard/src/display.ts',
    'packages/i18n/src/en-US.ts',
    'tsconfig.base.json',
    'apps/agent/tsconfig.json',
    'apps/agent/package.json',
    'pnpm-lock.yaml',
    'vitest.config.ts',
    'tooling/src/heavy.mjs',
    'apps/mcp-server/config/storm-mode.json',
    'packages/adapters/source-simulator/scenarios/storm-blackout.json',
    'packages/design-tokens/tokens.json',
  ])('runs the full check when %s changes (everything depends on it, or Vitest does not see it as an import)', (file) => {
    expect(planCheck(['apps/agent/src/agent.ts', file])).toEqual({ full: true, because: file });
  });
});

describe('check:changed finds the tests no import shows', () => {
  it('lists the tests that start apps as processes, so a change in any app code runs them too', () => {
    const tests = crossProcessTests();
    expect(tests).toEqual(expect.arrayContaining(['apps/sim-api/test/e2e/agentcore.test.ts', 'apps/alexa-sim/test/e2e/remote-mode.test.ts', 'apps/agent/test/e2e/bundle.test.ts']));
    expect(tests.every((t) => t.startsWith('apps/') && t.endsWith('.test.ts'))).toBe(true);
  });
});

describe('e2e:changed', () => {
  it('runs only the changed specs for a server-only change, with the site specs and the quick journeys', () => {
    expect(planE2e(['apps/mcp-server/src/modules/storm-mode/summaries.ts'])).toEqual({ scripted: 'changed', site: true });
  });

  it('runs the whole scripted suite when the page, its cards, texts or the shared helpers change', () => {
    for (const file of ['apps/alexa-sim/src/ui/AnswerCard.tsx', 'packages/ui-cards/src/PlanCard.tsx', 'packages/i18n/src/en-US.ts', 'e2e/support/ask.ts', 'e2e/no-network.ts', 'playwright.config.ts']) {
      expect(planE2e([file]).scripted, file).toBe('all');
    }
  });

  it('runs the whole scripted suite for a change in core or guard too: the page shows their plans and refusals', () => {
    expect(planE2e(['packages/core/src/simulation.ts']).scripted).toBe('all');
    expect(planE2e(['packages/guard/src/display.ts']).scripted).toBe('all');
  });

  it('runs no site step for a docs or tooling-only change', () => {
    expect(planE2e(['docs/outcomes.md', 'tooling/src/golden.mjs'])).toEqual({ scripted: 'changed', site: false });
  });
});

describe('heavy picks its workers from the free memory (O7)', () => {
  it('keeps two unit-test workers unless less than 2 GB is free, and adds a browser worker only above 6 GB', () => {
    expect(workersFor(7 * GB, {})).toEqual({ VITEST_MAX_WORKERS: '2', E2E_WORKERS: '2' });
    expect(workersFor(5 * GB, {})).toEqual({ VITEST_MAX_WORKERS: '2', E2E_WORKERS: '1' });
    expect(workersFor(3 * GB, {})).toEqual({ VITEST_MAX_WORKERS: '2', E2E_WORKERS: '1' });
    expect(workersFor(1.5 * GB, {})).toEqual({ VITEST_MAX_WORKERS: '1', E2E_WORKERS: '1' });
  });

  it('never overrides workers already set by the person or CI', () => {
    expect(workersFor(8 * GB, { VITEST_MAX_WORKERS: '4', E2E_WORKERS: '1' })).toEqual({ VITEST_MAX_WORKERS: '4', E2E_WORKERS: '1' });
  });
});
