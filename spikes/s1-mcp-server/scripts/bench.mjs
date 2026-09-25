// Local latency benchmark: server in its own process, client over real HTTP (keep-alive).
// Usage: node scripts/bench.mjs [requests=500] [concurrency=8]
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const N = Number(process.argv[2] ?? 500);
const CONCURRENCY = Number(process.argv[3] ?? 8);
const token = randomBytes(24).toString('hex');
const port = 3600 + Math.floor(Math.random() * 300);
const url = `http://127.0.0.1:${port}/mcp`;

const spawnedAt = performance.now();
const server = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), MCP_CLIENT_TOKENS: `bench=${token}` },
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
const bodies = {
  initialize: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'bench', version: '0' } } },
  'tools/list': { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  'tools/call ok': { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_reserve_status', arguments: { homeId: 'home-demo' } } },
  'tools/call error': { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_reserve_status', arguments: { homeId: 'nowhere' } } },
};

async function once(body) {
  const t = performance.now();
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  await res.arrayBuffer();
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  return performance.now() - t;
}

const firstResponse = await once(bodies.initialize);
const coldStartMs = performance.now() - spawnedAt;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return { n: s.length, p50: +pct(s, 50).toFixed(2), p95: +pct(s, 95).toFixed(2), p99: +pct(s, 99).toFixed(2), max: +s.at(-1).toFixed(2) };
}

for (let i = 0; i < 50; i++) await once(bodies['tools/call ok']); // warm-up

const results = {};
for (const [name, body] of Object.entries(bodies)) {
  const samples = [];
  for (let i = 0; i < N; i++) samples.push(await once(body));
  results[`${name} (sequential)`] = stats(samples);
}

const samples = [];
let next = 0;
const wallStart = performance.now();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next++ < N) samples.push(await once(bodies['tools/call ok']));
  }),
);
const wallMs = performance.now() - wallStart;
results[`tools/call ok (concurrency ${CONCURRENCY})`] = { ...stats(samples), rps: Math.round((samples.length / wallMs) * 1000) };

server.kill();

console.log(JSON.stringify({
  machine: { cpus: os.cpus().length, model: os.cpus()[0]?.model, node: process.version, platform: process.platform },
  coldStart: { spawnToFirstResponseMs: Math.round(coldStartMs), firstRequestMs: +firstResponse.toFixed(2), note: 'includes tsx transpilation; a bundled Lambda will be lower' },
  latencyMs: results,
}, null, 2));
