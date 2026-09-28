// Machine-wide lock so only one heavy step (install, full test run, synth) runs at a time.
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';

/**
 * @typedef {{ pid: number, startedAt: number, command: string }} LockHolder
 * @typedef {{ pid: number, now: () => number, isAlive: (pid: number) => boolean, staleMs: number, command: string }} LockOptions
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
      const { pid, startedAt, command } = /** @type {Record<string, unknown>} */ (value);
      if (typeof pid === 'number' && typeof startedAt === 'number' && typeof command === 'string') return { pid, startedAt, command };
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
      writeSync(fd, JSON.stringify({ pid: options.pid, startedAt: options.now(), command: options.command }));
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
