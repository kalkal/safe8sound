import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { siteServers, type SiteServer } from './servers.js';

// The journeys at many sizes against ONE build of the site and ONE start of the chain (O4, 18 Oct): builds the two
// sites once (a heavy slice), starts every server, then runs Playwright once per size, each its own heavy slice,
// reusing the servers (SITE_CHAIN_UP=1), and stops them at the end. Run by tooling/src/outcomes.mjs:
//   node node_modules/tsx/dist/cli.mjs e2e/site/with-chain.ts [--grep <tag>] <size>...
// The demo code and tokens are made once here (e2e/site/chain.ts) and reach every run through the environment.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HEAVY = join(ROOT, 'tooling', 'src', 'heavy.mjs');
const LOGS = join(ROOT, 'e2e-results', 'with-chain');

const args = process.argv.slice(2);
const at = args.indexOf('--grep');
const grep = at >= 0 ? args[at + 1] : undefined;
const sizes = args.filter((_, i) => i !== at && i !== at + 1);
if (sizes.length === 0) {
  console.error('usage: with-chain.ts [--grep <tag>] <size>...');
  process.exit(2);
}

const heavy = (command: string, cwd: string, env: Readonly<Record<string, string>> = {}) =>
  spawnSync(process.execPath, [HEAVY, command], { cwd: join(ROOT, cwd), stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;

/** Whether the server answers: its URL with any HTTP status, or its port taking a connection. */
async function up(server: SiteServer): Promise<boolean> {
  if (server.url !== undefined) return fetch(server.url).then(() => true, () => false);
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: server.port ?? 0 }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => {
      resolve(false);
    });
  });
}

/** Stops a server and everything it started (shell, node, vite). */
function stop(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(-child.pid, 'SIGTERM');
}

const servers = siteServers();
const running: ChildProcess[] = [];
const stopAll = () => {
  for (const child of running) stop(child);
};
process.on('SIGINT', () => {
  stopAll();
  process.exit(130);
});

const results: [string, number][] = [];
try {
  for (const server of servers.filter((s) => s.build !== undefined)) {
    console.log(`with-chain: building the ${server.name} once`);
    if (heavy(server.build ?? '', server.cwd, server.env) !== 0) throw new Error(`the ${server.name} did not build`);
  }
  mkdirSync(LOGS, { recursive: true });
  for (const server of servers) {
    // A server already on the port would be reused unseen while ours fails to bind: stop instead.
    if (await up(server)) throw new Error(`something already answers on the ${server.name}'s port: stop it, or run again (new ports)`);
    // Its output in a file, so a failed start says why (e2e-results/with-chain/).
    const log = openSync(join(LOGS, `${server.name.replace(/[^a-z0-9]+/gi, '-')}.log`), 'w');
    const child = spawn(server.serve, { cwd: join(ROOT, server.cwd), shell: true, stdio: ['ignore', log, log], env: { ...process.env, ...server.env }, detached: process.platform !== 'win32' });
    running.push(child);
    const deadline = Date.now() + server.timeoutMs;
    while (!(await up(server))) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`the ${server.name} did not start (see ${LOGS})`);
      await sleep(500);
    }
    console.log(`with-chain: the ${server.name} is up`);
  }
  for (const size of sizes) {
    console.log(`\nwith-chain: journeys at ${size}`);
    const playwright = `node node_modules/@playwright/test/cli.js test -c playwright.site.config.ts --project journey-${size}${grep === undefined ? '' : ` --grep "${grep}"`}`;
    results.push([size, heavy(playwright, '.', { SITE_CHAIN_UP: '1' })]);
  }
} catch (error) {
  console.error(`with-chain: ${error instanceof Error ? error.message : String(error)}`);
  results.push(['chain', 1]);
} finally {
  stopAll();
}
console.log('\nwith-chain:');
for (const [what, status] of results) console.log(`  ${status === 0 ? 'pass' : 'FAIL'}  ${what}${status === 0 ? '' : `  (screenshots: e2e-results/journeys/${what}/)`}`);
process.exit(results.every(([, status]) => status === 0) ? 0 : 1);
