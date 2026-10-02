import '../no-network.js';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TurnFailureSchema } from '@cold-reserve/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// G1a: the one-file CommonJS bundle AgentCore runs. Built here with scripts/bundle.ts, started with plain
// `node` the way the runtime starts it, then asked over HTTP. Fake model, no MCP server: nothing leaves
// the machine (cost rule).

const APP = fileURLToPath(new URL('../..', import.meta.url));
const BUNDLE = fileURLToPath(new URL('../../dist/agentcore/app.js', import.meta.url));
let child: ChildProcess | undefined;
let base = '';

beforeAll(async () => {
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/bundle.ts'], { cwd: APP, stdio: 'pipe' });
  expect(existsSync(BUNDLE)).toBe(true);
  const running = spawn(process.execPath, [BUNDLE], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', AGENT_MODEL_PROVIDER: 'fake', AGENT_MCP_URL: 'http://127.0.0.1:39999/mcp', AGENT_MCP_TOKEN: 'm'.repeat(40) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = running;
  base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the bundle did not start within 20 s'));
    }, 20_000);
    running.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.includes('"listening"')) continue;
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${String((JSON.parse(line) as { details: { port: number } }).details.port)}`);
      }
    });
    running.on('exit', (code) => {
      reject(new Error(`the bundle exited with ${String(code)}`));
    });
  });
}, 120_000);

afterAll(() => {
  child?.kill();
});

describe('the AgentCore bundle (dist/agentcore/app.js, CommonJS)', () => {
  it('starts with plain node and answers /ping as Healthy', async () => {
    const res = await fetch(`${base}/ping`);
    expect(await res.json()).toEqual({ status: 'Healthy' });
  });

  it('takes an invocation without a bearer and runs the turn (here the MCP server is down: a 200 failure envelope)', async () => {
    const res = await fetch(`${base}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Hi', home: 'demo#0123456789abcdef' }) });
    expect(res.status).toBe(200);
    expect(TurnFailureSchema.parse(await res.json())).toMatchObject({ code: 'agent_unavailable', category: 'dependency_unavailable' });
  });
});
