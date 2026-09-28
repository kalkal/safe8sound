import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireHeavyLock } from '../src/heavy-lock.mjs';

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
