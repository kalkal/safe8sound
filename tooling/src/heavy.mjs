// `pnpm heavy <command...>`: run a heavy command only when no other heavy command runs on this PC.
// The lock lives in the OS temp folder, so it is shared by every worktree and session.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireHeavyLock, isProcessAlive } from './heavy-lock.mjs';

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
const options = { pid: process.pid, now: Date.now, isAlive: isProcessAlive, staleMs: STALE_MS, command };

const started = Date.now();
let lock = acquireHeavyLock(LOCK_PATH, options);
while (!lock.ok) {
  if (Date.now() - started > MAX_WAIT_MS) {
    console.error(`heavy: gave up after ${String(Math.round(MAX_WAIT_MS / 60_000))} min; "${lock.holder.command}" (pid ${String(lock.holder.pid)}) still runs.`);
    process.exit(75);
  }
  console.error(`heavy: waiting for "${lock.holder.command}" (pid ${String(lock.holder.pid)})...`);
  await sleep(POLL_MS);
  lock = acquireHeavyLock(LOCK_PATH, options);
}

const { release } = lock;
const child = spawn(command, { stdio: 'inherit', shell: true });
const forward = (/** @type {NodeJS.Signals} */ signal) => child.kill(signal);
process.on('SIGINT', forward);
process.on('SIGTERM', forward);
child.on('error', (error) => {
  release();
  console.error(`heavy: could not start "${command}": ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  release();
  process.exit(code ?? (signal ? 1 : 0));
});
