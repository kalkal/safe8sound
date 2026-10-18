// `pnpm e2e:changed` (Tier A of the merge gate): the E2E a PR's changes can break.
// - The page, its cards, styles, texts or the shared E2E helpers changed: the whole scripted suite (`pnpm e2e`), since
//   any scene can show them. Otherwise only the changed specs (`--only-changed`).
// - The simulator, the chain behind the site (sim-api, agent, MCP server), the site specs or infra changed: both
//   journeys at the quick sizes (`pnpm journeys quick`), and `pnpm e2e:site`.
// Each step is its own `pnpm heavy` slice (the journeys slice per size themselves).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changedFiles } from './check-changed.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * What every scripted scene shows or uses: a change here can break any spec. Every package counts: the page imports
 * the cards, texts and tokens, and through them contracts, core and guard (the scripted plans and refusals).
 */
const PAGE = [
  /^apps\/alexa-sim\//,
  /^packages\//,
  /^e2e\/[^/]+\.ts$/,
  /^e2e\/support\//,
  /^playwright\.config\.ts$/,
  /(^|\/)package\.json$/,
  /^pnpm-lock\.yaml$/,
];

/** What the site's chain runs: a change here is seen by the journeys and the site specs. */
const CHAIN = [/^apps\/alexa-sim\//, /^apps\/(sim-api|agent|mcp-server)\//, /^packages\//, /^e2e\/site\//, /^e2e\/support\//, /^playwright\.site\.config\.ts$/, /^infra\//, /(^|\/)package\.json$/, /^pnpm-lock\.yaml$/];

/**
 * The E2E steps for these changed files.
 * @param {readonly string[]} files paths relative to the repo, with forward slashes
 * @returns {{ scripted: 'all' | 'changed', site: boolean }}
 */
export function planE2e(files) {
  const touches = (/** @type {readonly RegExp[]} */ paths) => files.some((f) => paths.some((p) => p.test(f)));
  return { scripted: touches(PAGE) ? 'all' : 'changed', site: touches(CHAIN) };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const base = process.argv[2] ?? 'origin/main';
  const plan = planE2e(changedFiles(base));
  const node = (/** @type {string[]} */ args) => spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' }).status ?? 1;
  const playwright = 'node node_modules/@playwright/test/cli.js test';
  const steps = [
    ['tooling/src/heavy.mjs', plan.scripted === 'all' ? playwright : `${playwright} --only-changed=${base} --pass-with-no-tests`],
    ...(plan.site ? [['tooling/src/heavy.mjs', `${playwright} -c playwright.site.config.ts --project site`], ['tooling/src/outcomes.mjs', 'journeys', 'quick']] : []),
  ];
  console.log(`e2e:changed: scripted ${plan.scripted === 'all' ? 'suite in full (the page or its helpers changed)' : 'specs changed only'}${plan.site ? '; site specs and quick journeys' : ''}.`);
  for (const step of steps) {
    const status = node(step);
    if (status !== 0) process.exit(status);
  }
}
