// The outcome suite (the outcome registry, docs/outcomes.md once approved), runnable from any session:
//   pnpm journey:judge [size...]   the judge's journey          (e2e/site/journeys/judge.journey.spec.ts)
//   pnpm journey:user [size...]    the user's journey           (e2e/site/journeys/user.journey.spec.ts)
//   pnpm journeys [size...]        both journeys, one build of the site per size
//   pnpm outcome <O1..O15> [size...]   every journey step tagged @outcome:<id>
//   pnpm outcomes [size...]        the golden tests, then every journey
// A size is an id of e2e/support/sizes.json (1904x870 ...) or `quick` (its quick sizes); none: every size. Each size is
// its own `pnpm heavy` slice (one heavy step at a time on the PC, the lock released between sizes, each well under
// 15 minutes). JOURNEY_PROBE=1 runs every known-bug step without failing and prints which pass. Screenshots of failing
// steps: e2e-results/journeys/<size>/; "before" screenshots of a probe: e2e-results/journeys/before/<size>/.
// A deployed site (after a deploy, with the owner's OK: the real model, the demo code's turns):
//   JOURNEY_BASE_URL=https://<site> JOURNEY_CODE_FILE=<local file, first line = the demo code> pnpm journey:judge 1904x870
// No local server then; the code is read from the file by the journey (e2e/support/target.ts), never printed.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** @type {{ quick: string[], sizes: { id: string }[] }} */
const SIZES = JSON.parse(readFileSync(new URL('../../e2e/support/sizes.json', import.meta.url), 'utf8'));
const JOURNEYS = ['judge', 'user'];

/**
 * The sizes asked for: ids, `quick`, or every size with none.
 * @param {readonly string[]} asked
 * @param {{ quick: readonly string[], sizes: readonly { id: string }[] }} sizes
 * @returns {{ ok: true, ids: string[] } | { ok: false, unknown: string[] }}
 */
export function sizesFor(asked, sizes = SIZES) {
  const all = sizes.sizes.map((s) => s.id);
  if (asked.length === 0) return { ok: true, ids: all };
  const ids = [...new Set(asked.flatMap((a) => (a === 'quick' ? sizes.quick : [a])))];
  const unknown = ids.filter((id) => !all.includes(id));
  return unknown.length > 0 ? { ok: false, unknown } : { ok: true, ids: all.filter((id) => ids.includes(id)) };
}

/**
 * What to run: the Playwright --grep of a journey or an outcome, and whether the golden tests come first.
 * @param {readonly string[]} argv
 * @returns {{ ok: true, grep: string | undefined, golden: boolean, label: string, sizes: string[] } | { ok: false, error: string }}
 */
export function planRun(argv) {
  const [command, ...rest] = argv;
  if (command === 'journey') {
    const [name, ...sizes] = rest;
    if (name === undefined || !JOURNEYS.includes(name)) return { ok: false, error: `journey: one of ${JOURNEYS.join(', ')}` };
    return withSizes({ grep: `@journey:${name}`, golden: false, label: `the ${name}'s journey` }, sizes);
  }
  if (command === 'outcome') {
    const [id, ...sizes] = rest;
    if (id === undefined || !/^O(?:[1-9]|1[0-5])$/.test(id)) return { ok: false, error: 'outcome: an outcome id, O1 to O15 of the outcome registry' };
    // O1 must not match O10-O15.
    return withSizes({ grep: `@outcome:${id}(?![0-9])`, golden: false, label: `outcome ${id}` }, sizes);
  }
  if (command === 'journeys') return withSizes({ grep: '@journey:', golden: false, label: 'both journeys' }, rest);
  if (command === 'all') return withSizes({ grep: undefined, golden: true, label: 'the golden tests and every journey' }, rest);
  return { ok: false, error: 'usage: outcomes.mjs journey <judge|user> | journeys | outcome <id> | all, then sizes' };
}

/**
 * @param {{ grep: string | undefined, golden: boolean, label: string }} run
 * @param {readonly string[]} asked
 * @returns {{ ok: true, grep: string | undefined, golden: boolean, label: string, sizes: string[] } | { ok: false, error: string }}
 */
function withSizes(run, asked) {
  const sizes = sizesFor(asked);
  if (!sizes.ok) return { ok: false, error: `no screen size ${sizes.unknown.join(', ')}; sizes: ${SIZES.sizes.map((s) => s.id).join(', ')}, quick` };
  return { ok: true, ...run, sizes: sizes.ids };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const plan = planRun(process.argv.slice(2));
  if (!plan.ok) {
    console.error(`outcomes: ${plan.error}`);
    process.exit(2);
  }
  if (process.env['JOURNEY_BASE_URL'] !== undefined && process.env['JOURNEY_CODE_FILE'] === undefined) {
    console.error('outcomes: JOURNEY_BASE_URL needs JOURNEY_CODE_FILE, a local file whose first line is the demo code.');
    process.exit(2);
  }
  const node = (/** @type {string[]} */ args) => spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' }).status ?? 1;
  /** @type {[string, number][]} */
  const results = [];
  if (plan.golden) results.push(['golden', node(['tooling/src/golden.mjs'])]);
  for (const id of plan.sizes) {
    const grep = plan.grep === undefined ? '' : ` --grep "${plan.grep}"`;
    const playwright = `node node_modules/@playwright/test/cli.js test -c playwright.site.config.ts --project journey-${id}${grep}`;
    console.log(`\noutcomes: ${plan.label} at ${id}`);
    results.push([id, node(['tooling/src/heavy.mjs', playwright])]);
  }
  console.log(`\noutcomes: ${plan.label}`);
  for (const [what, status] of results) console.log(`  ${status === 0 ? 'pass' : 'FAIL'}  ${what}${status === 0 ? '' : `  (screenshots: e2e-results/journeys/${what}/)`}`);
  process.exit(results.every(([, status]) => status === 0) ? 0 : 1);
}
