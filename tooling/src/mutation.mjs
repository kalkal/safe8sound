// `pnpm heavy pnpm mutation <group...> | --all`: Stryker on the guard and the F4 modules of core, threshold 80 %.
// Stryker's Vitest runner 10.0.0 runs no test per mutant with Vitest 5 (every mutant "survives"), so we use
// the command runner: each group of sources is mutated against the tests that exercise it, which keeps the
// run short enough for the heavy lock. Run it in slices (one or a few groups per `pnpm heavy` call, each
// under 15 minutes) so other sessions can take the lock in between; a full run only when the PC is idle. Reports land in reports/mutation/<group>.json; the overall score
// is printed at the end and the exit code is 1 below the threshold.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const THRESHOLD = 80;

/**
 * @typedef {{ name: string, mutate: string[], tests: string[] }} Group
 * @typedef {{ files: Record<string, { mutants: { status: string }[] }> }} Report
 * @typedef {'killed' | 'timeout' | 'survived' | 'noCoverage'} Counted
 */

/** @type {readonly Group[]} */
export const GROUPS = [
  { name: 'core-level', mutate: ['packages/core/src/level.ts'], tests: ['packages/core/test/level.test.ts'] },
  { name: 'core-reserve', mutate: ['packages/core/src/reserve.ts'], tests: ['packages/core/test/reserve.test.ts'] },
  { name: 'core-rooms', mutate: ['packages/core/src/rooms.ts'], tests: ['packages/core/test/rooms.test.ts'] },
  { name: 'core-night', mutate: ['packages/core/src/night.ts'], tests: ['packages/core/test/night.test.ts'] },
  { name: 'core-projection', mutate: ['packages/core/src/projection.ts'], tests: ['packages/core/test/projection.test.ts'] },
  { name: 'core-planner', mutate: ['packages/core/src/planner.ts'], tests: ['packages/core/test/planner.test.ts'] },
  { name: 'core-counterfactual', mutate: ['packages/core/src/counterfactual.ts'], tests: ['packages/core/test/counterfactual.test.ts'] },
  { name: 'guard-counterfactual', mutate: ['packages/guard/src/counterfactual.ts'], tests: ['packages/guard/test/counterfactual.test.ts'] },
  // The guard is split per source so that each slice stays well under 15 minutes of heavy lock.
  { name: 'guard-constraints', mutate: ['packages/guard/src/constraints.ts'], tests: ['packages/guard/test/constraints.test.ts'] },
  { name: 'guard-rejection', mutate: ['packages/guard/src/rejection.ts'], tests: ['packages/guard/test/rejection.test.ts'] },
  { name: 'guard-config', mutate: ['packages/guard/src/config.ts'], tests: ['packages/guard/test/config.test.ts'] },
  {
    name: 'guard-context',
    mutate: ['packages/guard/src/context.ts', 'packages/guard/src/guard.ts'],
    tests: ['packages/guard/test/context.test.ts', 'packages/guard/test/guard.test.ts', 'packages/guard/test/scenarios.test.ts'],
  },
  {
    name: 'guard-night',
    mutate: ['packages/guard/src/night.ts'],
    tests: ['packages/guard/test/night.test.ts', 'packages/guard/test/guard.test.ts', 'packages/guard/test/guard.property.test.ts'],
  },
  {
    name: 'guard-safe-until',
    mutate: ['packages/guard/src/safe-until.ts', 'packages/guard/src/dry-air.ts'],
    tests: ['packages/guard/test/safe-until.test.ts', 'packages/guard/test/constraints.test.ts', 'packages/guard/test/guard.test.ts'],
  },
  { name: 'guard-hold-safe-room', mutate: ['packages/guard/src/hold-safe-room.ts'], tests: ['packages/guard/test/hold-safe-room.test.ts'] },
  {
    name: 'guard-heat-danger',
    mutate: ['packages/guard/src/heat-danger.ts', 'packages/guard/src/humid-air.ts'],
    tests: ['packages/guard/test/heat-danger.test.ts', 'packages/guard/test/constraints.test.ts', 'packages/guard/test/safe-until.test.ts', 'packages/guard/test/guard.test.ts'],
  },
];

/** @type {Readonly<Record<string, Counted>>} */
const COUNTED = { Killed: 'killed', Timeout: 'timeout', Survived: 'survived', NoCoverage: 'noCoverage' };

/**
 * Stryker's mutation score over several JSON reports (mutation-testing-elements schema).
 * @param {readonly Report[]} reports
 */
export function mutationScore(reports) {
  const totals = { killed: 0, timeout: 0, survived: 0, noCoverage: 0 };
  for (const report of reports) {
    for (const file of Object.values(report.files)) {
      for (const mutant of file.mutants) {
        const key = COUNTED[mutant.status];
        if (key !== undefined) totals[key] += 1;
      }
    }
  }
  const valid = totals.killed + totals.timeout + totals.survived + totals.noCoverage;
  return { ...totals, valid, score: valid === 0 ? 0 : ((totals.killed + totals.timeout) / valid) * 100 };
}

/** @param {Group} group */
export function groupConfig(group) {
  return {
    testRunner: 'command',
    commandRunner: { command: `pnpm vitest run --config vitest.stryker.config.ts ${group.tests.join(' ')}` },
    coverageAnalysis: 'off',
    mutate: group.mutate,
    reporters: ['clear-text', 'json'],
    jsonReporter: { fileName: `reports/mutation/${group.name}.json` },
    clearTextReporter: { allowColor: false, logTests: false },
    thresholds: { high: 90, low: THRESHOLD, break: null },
    concurrency: 2,
    tempDirName: '.stryker-tmp',
    cleanTempDir: 'always',
  };
}

/**
 * The slices to run: named groups, or `--all` (only when no other session needs the heavy lock).
 * Nothing or an unknown name is a usage error (exit 2) that lists the groups.
 * @param {readonly string[]} args
 * @returns {{ ok: true, groups: Group[] } | { ok: false, exitCode: 2, message: string }}
 */
export function selectGroups(args) {
  const list = `Groups: ${GROUPS.map((g) => g.name).join(', ')}.`;
  if (args.length === 0) {
    return { ok: false, exitCode: 2, message: `usage: pnpm heavy pnpm mutation <group...> | --all
${list}` };
  }
  if (args.includes('--all')) return { ok: true, groups: [...GROUPS] };
  const unknown = args.find((a) => !GROUPS.some((g) => g.name === a));
  if (unknown !== undefined) return { ok: false, exitCode: 2, message: `Unknown group "${unknown}". ${list}` };
  return { ok: true, groups: GROUPS.filter((g) => args.includes(g.name)) };
}

function main() {
  const selected = selectGroups(process.argv.slice(2));
  if (!selected.ok) {
    console.error(selected.message);
    process.exit(selected.exitCode);
  }
  const groups = selected.groups;
  mkdirSync('reports/mutation', { recursive: true });
  /** @type {Report[]} */
  const reports = [];
  for (const group of groups) {
    const configPath = join('reports', 'mutation', `${group.name}.stryker.json`);
    writeFileSync(configPath, JSON.stringify(groupConfig(group), null, 2));
    console.log(`\n== ${group.name}: ${group.mutate.join(', ')}`);
    const run = spawnSync('pnpm', ['exec', 'stryker', 'run', configPath], { stdio: 'inherit', shell: true });
    rmSync(configPath, { force: true });
    if (run.status !== 0) {
      console.error(`Stryker failed on ${group.name} (exit ${String(run.status)}).`);
      process.exit(1);
    }
    reports.push(/** @type {Report} */ (JSON.parse(readFileSync(join('reports', 'mutation', `${group.name}.json`), 'utf8'))));
  }
  const s = mutationScore(reports);
  console.log(`\nMutation score ${s.score.toFixed(2)} % (killed ${s.killed}, timeout ${s.timeout}, survived ${s.survived}, no coverage ${s.noCoverage}); threshold ${THRESHOLD} %.`);
  process.exit(s.score >= THRESHOLD ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
