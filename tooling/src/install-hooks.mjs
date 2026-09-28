// `pnpm prepare`: point git at the versioned hooks in .githooks (secret scan).
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * @param {{ ci: boolean, insideWorkTree: boolean, worktreeConfig: boolean }} context
 * @returns {string[] | null} git arguments, or null when nothing must be done
 */
export function hooksPathArgs({ ci, insideWorkTree, worktreeConfig }) {
  if (ci || !insideWorkTree) return null;
  return ['config', worktreeConfig ? '--worktree' : '--local', 'core.hooksPath', '.githooks'];
}

/** @param {string[]} args */
const git = (args) => spawnSync('git', args, { encoding: 'utf8' });

function main() {
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  const args = hooksPathArgs({
    ci: Boolean(process.env['CI']),
    insideWorkTree: inside.status === 0 && inside.stdout.trim() === 'true',
    worktreeConfig: git(['config', '--get', 'extensions.worktreeConfig']).stdout.trim() === 'true',
  });
  if (!args) return;
  const result = git(args);
  if (result.status !== 0) {
    console.error(`install-hooks: git ${args.join(' ')} failed: ${result.stderr}`);
    process.exit(1);
  }
  console.log('install-hooks: core.hooksPath -> .githooks');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
