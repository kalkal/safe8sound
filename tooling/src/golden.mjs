// `pnpm golden [name...]`: the golden tests (C0, 18 Oct), exact snapshots of today's outputs that a migration must
// leave unchanged. With no name, all of them; a name is a file's base name (`tools` runs every tools.golden.test.ts).
// `pnpm golden --list` prints the names. They run in a fixed time zone and never rewrite a snapshot that differs.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SUFFIX = /\.golden\.test\.tsx?$/;
const SKIP = new Set(['node_modules', 'dist', '.git']);

/**
 * Every golden test file under `root`, as a path relative to it with forward slashes.
 * @param {string} [root]
 * @param {string} [dir]
 * @returns {string[]}
 */
export function goldenFiles(root = ROOT, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : goldenFiles(root, join(dir, entry.name));
    const path = relative(root, join(dir, entry.name)).split(sep).join('/');
    return SUFFIX.test(entry.name) && path.includes('/test/golden/') ? [path] : [];
  });
}

/** A file's golden name: its base name without `.golden.test.ts`. @param {string} file */
export const goldenName = (file) => file.slice(file.lastIndexOf('/') + 1).replace(SUFFIX, '');

/**
 * The files to run for the names asked (all with none), or the names that match no file.
 * @param {readonly string[]} files
 * @param {readonly string[]} names
 * @returns {{ ok: true, files: readonly string[] } | { ok: false, unknown: string[] }}
 */
export function selectGolden(files, names) {
  if (names.length === 0) return { ok: true, files };
  const unknown = names.filter((n) => !files.some((f) => goldenName(f) === n));
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, files: files.filter((f) => names.includes(goldenName(f))) };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const files = goldenFiles();
  const names = [...new Set(files.map(goldenName))].sort();
  if (args.includes('--list')) {
    console.log(names.join('\n'));
    process.exit(0);
  }
  const picked = selectGolden(files, args);
  if (!picked.ok) {
    console.error(`golden: no golden test named ${picked.unknown.join(', ')}. Names: ${names.join(', ')}.`);
    process.exit(2);
  }
  // --update=none: a snapshot that differs or is missing fails, it is never written (`-u` is for the PR that adds a golden).
  const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const run = spawnSync(process.execPath, [vitest, 'run', '--update=none', ...picked.files], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TZ: 'UTC' } });
  process.exit(run.status ?? 1);
}
