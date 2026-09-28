import { describe, expect, it } from 'vitest';
import { hooksPathArgs } from '../src/install-hooks.mjs';

describe('install-hooks (pnpm prepare)', () => {
  it('points core.hooksPath to the versioned .githooks folder', () => {
    expect(hooksPathArgs({ ci: false, insideWorkTree: true, worktreeConfig: false })).toEqual(['config', '--local', 'core.hooksPath', '.githooks']);
  });

  it('writes the worktree scope when worktree config is on, so an older per-worktree value cannot win', () => {
    expect(hooksPathArgs({ ci: false, insideWorkTree: true, worktreeConfig: true })).toEqual(['config', '--worktree', 'core.hooksPath', '.githooks']);
  });

  it('does nothing in CI or outside a git work tree', () => {
    expect(hooksPathArgs({ ci: true, insideWorkTree: true, worktreeConfig: false })).toBeNull();
    expect(hooksPathArgs({ ci: false, insideWorkTree: false, worktreeConfig: false })).toBeNull();
  });
});
