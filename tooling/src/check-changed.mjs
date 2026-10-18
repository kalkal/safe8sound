// `pnpm check:changed` (Tier A of the merge gate): the checks of `pnpm check` on what a PR changes.
// Static checks (types, lint, styles, module boundaries) always run in full (types, styles and boundaries with their
// caches; lint without); the unit tests run
// for the changed files and what imports them (`vitest --changed`), plus the workspace rules (tooling/test) and the
// golden tests. Files the tests read from disk rerun every test (vitest.config.ts forceRerunTriggers); a change in an
// app's code also runs the tests that start apps as processes (found by their spawn/fork), which no import shows. A
// PR that touches what everything depends on runs the full `pnpm check` instead. Each step is its own `pnpm heavy`
// slice; never wrap this command in `pnpm heavy` itself.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** A test that starts another process (an app from its sources, a bundle): its dependencies are not imports. */
const STARTS_A_PROCESS = /\b(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(/;

/**
 * The tests under `apps/<app>/test` that start a process, as paths relative to the repo.
 * @param {string} [root]
 * @returns {string[]}
 */
export function crossProcessTests(root = ROOT) {
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(join(dir, e.name))) : /\.test\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
  const apps = readdirSync(join(root, 'apps'), { withFileTypes: true }).filter((e) => e.isDirectory());
  return apps
    .map((app) => join(root, 'apps', app.name, 'test'))
    // An app with no tests yet has no test folder.
    .flatMap((tests) => (existsSync(tests) ? walk(tests) : []))
    .filter((file) => STARTS_A_PROCESS.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(root.length).replace(/^[\\/]+/, '').split('\\').join('/'))
    .sort();
}

/** A change in an app's own code or in a package an app runs: the tests that start apps as processes run too. */
const APP_CODE = /^(?:apps\/[^/]+\/src|packages)\//;

/**
 * The paths whose change asks for the full check: shared contracts and pure rules everything imports, the i18n
 * catalogs, the workspace and tool configuration, and shipped config JSON read at run time (not imported).
 */
const CENTRAL = [
  /^packages\/contracts\//,
  /^packages\/core\//,
  /^packages\/guard\//,
  /^packages\/i18n\//,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^vitest\.config\.ts$/,
  /^eslint\.config\.mjs$/,
  /^\.dependency-cruiser\.cjs$/,
  /^tooling\//,
  /(^|\/)config\/[^/]+\.json$/,
  /^packages\/adapters\/source-simulator\/(data|scenarios|locations)\//,
  /^packages\/design-tokens\//,
];

/**
 * What to run for these changed files: the full check, or the changed tests on top of the static checks.
 * @param {readonly string[]} files paths relative to the repo, with forward slashes
 * @returns {{ full: true, because: string } | { full: false }}
 */
export function planCheck(files) {
  const central = files.find((f) => CENTRAL.some((p) => p.test(f)));
  return central === undefined ? { full: false } : { full: true, because: central };
}

/**
 * The files this branch changes against its base, committed or not.
 * @param {string} base
 */
export function changedFiles(base) {
  const git = (/** @type {string[]} */ args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((l) => l.length > 0);
  const since = git(['merge-base', 'HEAD', base])[0] ?? base;
  return [...new Set([...git(['diff', '--name-only', since]), ...git(['ls-files', '--others', '--exclude-standard'])])];
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const base = process.argv[2] ?? 'origin/main';
  const files = changedFiles(base);
  const plan = planCheck(files);
  const heavy = (/** @type {string} */ command) => spawnSync(process.execPath, ['tooling/src/heavy.mjs', command], { cwd: ROOT, stdio: 'inherit' }).status ?? 1;
  const steps = plan.full
    ? ['pnpm check']
    : [
        'pnpm typecheck',
        'pnpm lint',
        'pnpm lint:css',
        'pnpm depcruise',
        'pnpm --filter @cold-reserve/ui-cards build:card',
        `pnpm exec vitest run --changed ${base} --passWithNoTests`,
        ...(files.some((f) => APP_CODE.test(f)) ? [`pnpm exec vitest run ${crossProcessTests().join(' ')}`] : []),
        'pnpm exec vitest run tooling/test',
        'node tooling/src/golden.mjs',
      ];
  console.log(plan.full ? `check:changed: ${plan.because} is central: the full check.` : `check:changed: ${String(files.length)} files changed since ${base}; the changed tests.`);
  for (const step of steps) {
    console.log(`\ncheck:changed: ${step}`);
    const status = heavy(step);
    if (status !== 0) process.exit(status);
  }
}
