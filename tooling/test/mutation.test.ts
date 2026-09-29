import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { GROUPS, groupConfig, mutationScore, selectGroups } from '../src/mutation.mjs';

const report = (statuses: string[]) => ({ files: { 'a.ts': { mutants: statuses.map((status, i) => ({ id: String(i), status })) } } });

describe('mutation score across groups', () => {
  it('is (killed + timeout) / (killed + timeout + survived + no coverage), in percent', () => {
    const s = mutationScore([report(['Killed', 'Killed', 'Timeout', 'Survived']), report(['NoCoverage', 'Killed'])]);
    expect(s).toMatchObject({ killed: 3, timeout: 1, survived: 1, noCoverage: 1, valid: 6 });
    expect(s.score).toBeCloseTo((4 / 6) * 100, 9);
  });

  it('leaves compile errors, runtime errors and ignored mutants out of the score', () => {
    expect(mutationScore([report(['Killed', 'CompileError', 'RuntimeError', 'Ignored'])]).score).toBe(100);
  });

  it('is 0 with no valid mutant, never NaN', () => {
    expect(mutationScore([]).score).toBe(0);
  });
});

describe('groups', () => {
  it('mutate each source only against the tests that exercise it', () => {
    for (const g of GROUPS) {
      expect(g.mutate.length).toBeGreaterThan(0);
      expect(g.tests.length).toBeGreaterThan(0);
    }
    expect(new Set(GROUPS.map((g) => g.name)).size).toBe(GROUPS.length);
  });

  it('build a command-runner config that runs the group tests with the Stryker Vitest config', () => {
    const g = GROUPS[0];
    if (g === undefined) throw new Error('no groups');
    const c = groupConfig(g);
    expect(c).toMatchObject({ testRunner: 'command', coverageAnalysis: 'off', mutate: g.mutate });
    expect(c.commandRunner.command).toBe(`pnpm vitest run --config vitest.stryker.config.ts ${g.tests.join(' ')}`);
    expect(c.jsonReporter.fileName).toBe(`reports/mutation/${g.name}.json`);
  });
});

describe('choosing the slices', () => {
  it('needs a group or --all: no argument prints the list and exits 2', () => {
    const r = selectGroups([]);
    expect(r).toMatchObject({ ok: false, exitCode: 2 });
    expect(!r.ok && r.message).toContain('core-level');
  });

  it('refuses an unknown group with exit 2 and the list', () => {
    const r = selectGroups(['core-level', 'nope']);
    expect(r).toMatchObject({ ok: false, exitCode: 2 });
    expect(!r.ok && r.message).toMatch(/Unknown group "nope"/);
  });

  it('runs the named groups, or every group with --all', () => {
    expect(selectGroups(['core-level']).ok && selectGroups(['core-level'])).toMatchObject({ groups: [{ name: 'core-level' }] });
    const all = selectGroups(['--all']);
    expect(all.ok && all.groups).toHaveLength(GROUPS.length);
  });
});

describe('group paths', () => {
  it('every file a group mutates or tests exists', () => {
    for (const g of GROUPS) {
      for (const path of [...g.mutate, ...g.tests].filter((p) => !p.startsWith('!'))) expect(existsSync(path), path).toBe(true);
    }
  });

  it('the scenario tests of the guard run in a guard group', () => {
    expect(GROUPS.some((g) => g.tests.includes('packages/guard/test/scenarios.test.ts'))).toBe(true);
  });
});
