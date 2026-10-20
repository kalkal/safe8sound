// Machine-wide lock so only one heavy step (install, full test run, synth) runs at a time.
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';

/**
 * @typedef {{ pid: number, startedAt: number, command: string, where?: string }} LockHolder
 * @typedef {{ pid: number, now: () => number, isAlive: (pid: number) => boolean, staleMs: number, command: string, where?: string }} LockOptions
 * @typedef {{ ok: true, release: () => void } | { ok: false, holder: LockHolder }} LockResult
 */

/**
 * @param {unknown} error
 * @param {string} code
 */
const isErrnoCode = (error, code) => error instanceof Error && 'code' in error && error.code === code;

/**
 * @param {string} lockPath
 * @returns {LockHolder | undefined} undefined when the file is missing or unreadable
 */
function readHolder(lockPath) {
  try {
    const value = /** @type {unknown} */ (JSON.parse(readFileSync(lockPath, 'utf8')));
    if (typeof value === 'object' && value !== null && 'pid' in value && 'startedAt' in value && 'command' in value) {
      const { pid, startedAt, command, where } = /** @type {Record<string, unknown>} */ (value);
      if (typeof pid === 'number' && typeof startedAt === 'number' && typeof command === 'string') return { pid, startedAt, command, ...(typeof where === 'string' ? { where } : {}) };
    }
    return undefined;
  } catch (error) {
    // A missing file means the holder released it in the meantime; bad JSON means a crashed writer.
    if (isErrnoCode(error, 'ENOENT') || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * @param {string} lockPath
 * @param {LockOptions} options
 * @returns {boolean} true when the lock file was created by us
 */
function tryCreate(lockPath, options) {
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      // `where`: the worktree that started it, so whoever stops a stuck step stops only its own (18 Oct).
      writeSync(fd, JSON.stringify({ pid: options.pid, startedAt: options.now(), command: options.command, ...(options.where === undefined ? {} : { where: options.where }) }));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if (isErrnoCode(error, 'EEXIST')) return false;
    throw error;
  }
}

/**
 * @param {string} lockPath
 * @param {LockOptions} options
 * @returns {LockResult}
 */
export function acquireHeavyLock(lockPath, options) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreate(lockPath, options)) {
      return {
        ok: true,
        release: () => {
          if (readHolder(lockPath)?.pid === options.pid) rmSync(lockPath, { force: true });
        },
      };
    }
    const holder = readHolder(lockPath);
    const stale = !holder || !options.isAlive(holder.pid) || options.now() - holder.startedAt > options.staleMs;
    if (!stale) return { ok: false, holder };
    rmSync(lockPath, { force: true });
  }
  const holder = readHolder(lockPath);
  if (holder) return { ok: false, holder };
  throw new Error(`heavy: could not create ${lockPath} after removing a stale lock twice`);
}

/** @param {number} pid */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return isErrnoCode(error, 'EPERM');
  }
}

const GB = 1024 ** 3;

/**
 * Workers for the tests a heavy step runs, from the free memory now (O7, 18 Oct): the unit tests keep their 2 workers
 * unless less than 2 GB is free; the browser tests take a second worker only with more than 6 GB free (a run grows
 * while it goes: at 4 GB the PC ran out of memory on 18 Oct). A value
 * already set (by the person or CI) wins.
 * @param {number} freeBytes
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {{ VITEST_MAX_WORKERS: string, E2E_WORKERS: string }}
 */
export function workersFor(freeBytes, env) {
  return { VITEST_MAX_WORKERS: env['VITEST_MAX_WORKERS'] ?? (freeBytes > 2 * GB ? '2' : '1'), E2E_WORKERS: env['E2E_WORKERS'] ?? (freeBytes > 6 * GB ? '2' : '1') };
}

/** What a heavy step tells the command it runs: the pid that holds the lock for it. */
export const HEAVY_HOLDER_ENV = 'COLD_RESERVE_HEAVY_HOLDER';

/**
 * Whether a heavy step runs inside one that already holds the lock for it (`pnpm heavy pnpm journeys`: the journeys
 * take the lock once per size). It then runs at once, instead of waiting for itself forever. The lock is cooperative:
 * a step that names the holder's pid is trusted, as every step on this PC is ours.
 * @param {string} lockPath
 * @param {Readonly<Record<string, string | undefined>>} env
 */
export function heldForUs(lockPath, env) {
  const pid = Number(env[HEAVY_HOLDER_ENV]);
  return Number.isInteger(pid) && pid > 0 && readHolder(lockPath)?.pid === pid;
}

/**
 * How to stop a heavy step's whole process tree, or undefined where the child's own signal is enough. On Windows
 * `child.kill()` on a `shell: true` child stops cmd.exe only: Playwright and its Chrome kept running (20 Oct).
 * @param {NodeJS.Platform} platform
 * @param {number} pid
 * @returns {{ command: string, args: string[] } | undefined}
 */
export function treeKill(platform, pid) {
  return platform === 'win32' ? { command: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] } : undefined;
}
