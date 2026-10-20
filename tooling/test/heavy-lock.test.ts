import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEAVY_HOLDER_ENV, acquireHeavyLock, heldForUs, treeKill } from '../src/heavy-lock.mjs';

let dir: string;
let lockPath: string;
const alive = new Set<number>();
const opts = (pid: number, now = 1_000_000) => ({ pid, now: () => now, isAlive: (p: number) => alive.has(p), staleMs: 60 * 60_000, command: 'pnpm test' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'heavy-lock-'));
  lockPath = join(dir, 'heavy.lock');
  alive.clear();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pnpm heavy lock (one heavy step at a time on this PC)', () => {
  it('takes a free lock and writes who holds it', () => {
    alive.add(100);
    const result = acquireHeavyLock(lockPath, opts(100));
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: 100, command: 'pnpm test' });
  });

  it('reports the holder when the lock is busy', () => {
    alive.add(100).add(200);
    acquireHeavyLock(lockPath, opts(100));
    const second = acquireHeavyLock(lockPath, opts(200));
    expect(second).toMatchObject({ ok: false, holder: { pid: 100, command: 'pnpm test' } });
  });

  it('takes over a lock whose process is gone', () => {
    alive.add(200);
    writeFileSync(lockPath, JSON.stringify({ pid: 100, startedAt: 999_000, command: 'old' }));
    expect(acquireHeavyLock(lockPath, opts(200)).ok).toBe(true);
  });

  it('takes over a lock older than the stale limit even if the pid was reused', () => {
    alive.add(100).add(200);
    writeFileSync(lockPath, JSON.stringify({ pid: 100, startedAt: 0, command: 'old' }));
    expect(acquireHeavyLock(lockPath, opts(200, 2 * 60 * 60_000)).ok).toBe(true);
  });

  it('treats an unreadable lock file as stale instead of blocking forever', () => {
    alive.add(200);
    writeFileSync(lockPath, 'not json');
    expect(acquireHeavyLock(lockPath, opts(200)).ok).toBe(true);
  });

  it('releases only its own lock', () => {
    alive.add(100).add(200);
    const first = acquireHeavyLock(lockPath, opts(100));
    if (!first.ok) throw new Error('expected the lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 200, startedAt: 1_000_000, command: 'other' }));
    first.release();
    expect(existsSync(lockPath)).toBe(true);
  });

  it('removes the lock file on release', () => {
    alive.add(100);
    const result = acquireHeavyLock(lockPath, opts(100));
    if (!result.ok) throw new Error('expected the lock');
    result.release();
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('who holds the lock', () => {
  it('names the worktree that took it, so a stuck step is stopped by its own session only', () => {
    alive.add(100).add(200);
    acquireHeavyLock(lockPath, { ...opts(100), where: 'C:/repo/.worktrees/main-journey' });
    const busy = acquireHeavyLock(lockPath, opts(200));
    expect(busy).toMatchObject({ ok: false, holder: { pid: 100, where: 'C:/repo/.worktrees/main-journey' } });
  });
});

describe('a heavy step inside a heavy step (18 Oct: `pnpm heavy pnpm journeys` waited on itself)', () => {
  it('runs at once when the lock is held by the heavy step that started it', () => {
    alive.add(100);
    const held = acquireHeavyLock(lockPath, opts(100));
    expect(held.ok).toBe(true);
    expect(heldForUs(lockPath, { [HEAVY_HOLDER_ENV]: '100' })).toBe(true);
  });

  it('waits like any other step when another step holds the lock, when it is free, or when the flag is missing or bad', () => {
    alive.add(100);
    expect(heldForUs(lockPath, { [HEAVY_HOLDER_ENV]: '100' })).toBe(false);
    acquireHeavyLock(lockPath, opts(100));
    expect(heldForUs(lockPath, { [HEAVY_HOLDER_ENV]: '200' })).toBe(false);
    expect(heldForUs(lockPath, {})).toBe(false);
    expect(heldForUs(lockPath, { [HEAVY_HOLDER_ENV]: 'x' })).toBe(false);
  });
});

describe('stopping a heavy step (20 Oct: Chrome left behind on Windows)', () => {
  it('on Windows stops the whole process tree with taskkill, not only the shell', () => {
    expect(treeKill('win32', 4242)).toEqual({ command: 'taskkill', args: ['/PID', '4242', '/T', '/F'] });
  });

  it('elsewhere leaves the signal to the child, which the shell passes on', () => {
    expect(treeKill('linux', 4242)).toBeUndefined();
    expect(treeKill('darwin', 4242)).toBeUndefined();
  });
});

describe('pnpm heavy inside pnpm heavy, as real processes', () => {
  it('runs the inner command at once, passes its exit code, and leaves no lock behind', () => {
    const heavy = fileURLToPath(new URL('../src/heavy.mjs', import.meta.url));
    const inner = join(dir, 'inner.cjs');
    writeFileSync(inner, 'process.exit(7);');
    // The lock lives in the OS temp folder: a scratch one here, so the PC's real lock is never touched.
    const run = spawnSync(process.execPath, [heavy, 'node', heavy, 'node', inner], {
      env: { ...process.env, TEMP: dir, TMP: dir, HEAVY_MAX_WAIT_MS: '10000' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(run.status, run.stderr).toBe(7);
    expect(run.stderr).not.toContain('waiting for');
    expect(existsSync(join(dir, 'cold-reserve-heavy.lock'))).toBe(false);
  });
});
