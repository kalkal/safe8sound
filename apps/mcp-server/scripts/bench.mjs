// Local latency of get_home_status (plan §1 principle 9: tools < 500 ms p95 warm).
// Starts the local Node entry in its own process, warms it up, then times N sequential calls.
// Usage: node scripts/bench.mjs [calls=100] [port=3316]
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const N = Number(process.argv[2] ?? 100);
const port = Number(process.argv[3] ?? 3316);
const token = randomBytes(24).toString('hex');
const url = `http://127.0.0.1:${port}/mcp`;

const server = spawn(process.execPath, ['--import', 'tsx', 'src/local.ts'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), MCP_CLIENTS: `bench@demo=${token}`, MCP_SCENARIO: 'clear-day' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes('listening') && resolve());
  server.once('exit', (code) => reject(new Error(`server exited with ${code}`)));
});

const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${token}`,
  'mcp-protocol-version': '2025-11-25',
};
const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_home_status', arguments: {} } };

async function once() {
  const t = performance.now();
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(call) });
  const body = await res.json();
  if (res.status !== 200 || body.result?.isError) throw new Error(`call failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return performance.now() - t;
}

try {
  for (let i = 0; i < 20; i++) await once(); // warm-up
  const samples = [];
  for (let i = 0; i < N; i++) samples.push(await once());
  samples.sort((a, b) => a - b);
  const pct = (p) => +samples[Math.min(samples.length - 1, Math.ceil((p / 100) * samples.length) - 1)].toFixed(2);
  console.log(JSON.stringify({ tool: 'get_home_status', calls: N, p50Ms: pct(50), p95Ms: pct(95), p99Ms: pct(99), maxMs: +samples.at(-1).toFixed(2), targetP95Ms: 500 }));
  process.exitCode = pct(95) < 500 ? 0 : 1;
} finally {
  server.kill();
}
