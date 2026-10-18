// `pnpm heavy <command...>`: run a heavy command only when no other heavy command runs on this PC.
// The lock lives in the OS temp folder, so it is shared by every worktree and session.
// A heavy command started inside one that holds the lock for it (`pnpm heavy pnpm journeys`: the journeys take the
// lock once per size) runs at once: waiting would wait for itself (deadlock seen on 18 Oct).
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { HEAVY_HOLDER_ENV, acquireHeavyLock, heldForUs, isProcessAlive } from './heavy-lock.mjs';

const LOCK_PATH = join(tmpdir(), 'cold-reserve-heavy.lock');
const POLL_MS = 5_000;
const STALE_MS = 2 * 60 * 60_000;
const MAX_WAIT_MS = Number(process.env['HEAVY_MAX_WAIT_MS'] ?? 60 * 60_000);

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: pnpm heavy <command> [args...]');
  process.exit(2);
}
const command = args.join(' ');
const options = { pid: process.pid, now: Date.now, isAlive: isProcessAlive, staleMs: STALE_MS, command, where: process.cwd() };

/**
 * Runs the command; `release` (when this step took the lock) frees it at the end. The command learns who holds the
 * lock for it, so a heavy step inside it does not wait for this one.
 * @param {(() => void) | undefined} release
 * @param {string} holder
 */
function run(release, holder) {
  const child = spawn(command, { stdio: 'inherit', shell: true, env: { ...process.env, [HEAVY_HOLDER_ENV]: holder } });
  const forward = (/** @type {NodeJS.Signals} */ signal) => child.kill(signal);
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  child.on('error', (error) => {
    release?.();
    console.error(`heavy: could not start "${command}": ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    release?.();
    process.exit(code ?? (signal ? 1 : 0));
  });
}

if (heldForUs(LOCK_PATH, process.env)) {
  run(undefined, process.env[HEAVY_HOLDER_ENV] ?? '');
} else {
  const started = Date.now();
  let lock = acquireHeavyLock(LOCK_PATH, options);
  while (!lock.ok) {
    if (Date.now() - started > MAX_WAIT_MS) {
      console.error(`heavy: gave up after ${String(Math.round(MAX_WAIT_MS / 60_000))} min; "${lock.holder.command}" (pid ${String(lock.holder.pid)}) still runs.`);
      process.exit(75);
    }
    console.error(`heavy: waiting for "${lock.holder.command}" (pid ${String(lock.holder.pid)}${lock.holder.where === undefined ? '' : `, in ${lock.holder.where}`})...`);
    await sleep(POLL_MS);
    lock = acquireHeavyLock(LOCK_PATH, options);
  }
  run(lock.release, String(process.pid));
}
