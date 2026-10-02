// The official MCP conformance suite against the local MCP server (G5, #153). The suite sends no token and
// our server requires one, so a local proxy adds the bearer. `pnpm conformance` starts the server, the proxy
// and the suite, then stops them. Usage: pnpm heavy pnpm conformance [-- --scenario <name>]
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';

/** The suite's version: pinned, reviewed against the supply-chain rules (released 2026-03-30, no install scripts). */
export const SUITE = '@modelcontextprotocol/conformance@0.1.16';
const SERVER_PORT = 3398;
const PROXY_PORT = 3399;
const BASELINE = 'tooling/conformance-baseline.yml';

/** One JSON line on stderr: what the proxy could not do, with the cause's name and never its text. */
const stderrLine = (/** @type {string} */ line) => {
  process.stderr.write(line);
};

/**
 * A proxy to `target` that sets `Authorization: Bearer <token>` on every request and returns the reply as it is.
 * It rewrites Host to the target's, so the suite's DNS rebinding scenario exercises the Origin check only (the
 * server relies on listening on 127.0.0.1 plus the bearer, not on Host).
 * @param {{ target: string; token: string; log?: (line: string) => void }} opts
 */
export function createBearerProxy(opts) {
  const target = new URL(opts.target);
  const log = opts.log ?? stderrLine;
  return createServer((req, res) => {
    const headers = { ...req.headers, host: target.host, authorization: `Bearer ${opts.token}` };
    const upstream = request({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', (cause) => {
      if (res.destroyed) return;
      log(`${JSON.stringify({ component: 'conformance-proxy', code: 'upstream_unavailable', message: 'The MCP server did not answer.', errorName: cause.name })}\n`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('The MCP server did not answer.');
    });
    // The client went away: drop the request to the server too.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  });
}

/**
 * Listens on 127.0.0.1; rejects when the port is taken, so the caller can stop what it started.
 * @param {import('node:http').Server} server @param {number} port
 * @returns {Promise<void>}
 */
export function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * Runs a command and resolves with its exit code.
 * @param {string} cmd @param {string[]} args @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
const run = (cmd, args, env = process.env) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });

async function main() {
  const token = randomBytes(24).toString('hex');
  const server = spawn(process.execPath, ['--import', 'tsx', 'apps/mcp-server/src/local.ts'], {
    // The suite sends Origin http://127.0.0.1:<proxy> and expects a localhost Origin to be accepted; our server
    // takes browser origins from an explicit allowlist (stricter), so the run lists the proxy's origin.
    env: { ...process.env, MCP_CLIENTS: `conformance@demo=${token}`, PORT: String(SERVER_PORT), MCP_ALLOWED_ORIGINS: `http://127.0.0.1:${String(PROXY_PORT)}` },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const stop = () => {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(server.pid), '/T', '/F']);
    else server.kill();
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The MCP server did not start within 30 s.')), 30_000);
      server.stdout.on('data', (/** @type {Buffer} */ chunk) => {
        if (chunk.toString().includes('listening on')) {
          clearTimeout(timer);
          resolve(undefined);
        }
      });
      server.on('exit', () => reject(new Error('The MCP server exited before listening.')));
      server.on('error', reject);
    });
    const proxy = createBearerProxy({ target: `http://127.0.0.1:${String(SERVER_PORT)}`, token });
    await listenOn(proxy, PROXY_PORT);
    const extra = process.argv.slice(2).filter((a) => a !== '--');
    const baseline = existsSync(BASELINE) ? ['--expected-failures', BASELINE] : [];
    const code = await run('pnpm', ['dlx', SUITE, 'server', '--url', `http://127.0.0.1:${String(PROXY_PORT)}/mcp`, '-o', 'reports/conformance', ...baseline, ...extra]);
    proxy.close();
    process.exitCode = code;
  } finally {
    stop();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
