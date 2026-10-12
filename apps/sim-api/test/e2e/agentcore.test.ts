import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { HomeIdSchema, type LogEntry } from '@cold-reserve/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentCoreTurnAgent } from '../../src/adapters/agentcore.js';

// G1c (#17) end to end, without AWS: sim-api's AgentCore adapter with the real AWS SDK client (fake
// credentials) -> a local stand-in for AgentCore (POST /runtimes/{arn}/invocations, and 424
// RuntimeClientError when the container fails, as the service does) -> the real agent's AgentCore entry
// (fake model) -> the real MCP server. Nothing leaves the machine (cost rule).

const APPS = fileURLToPath(new URL('../../..', import.meta.url));
const ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/cold_reserve_dev_agent-test';
const HOME = HomeIdSchema.parse('demo#0123456789abcdef');
const TOKEN = randomBytes(24).toString('hex');
const children: ChildProcess[] = [];
let agentCore: Server | undefined;
let agentCoreUrl = '';
let failContainer = false;

/** Starts `src/<entry>` of an app and resolves with what `found` extracts from its stdout. */
function start(app: string, entry: string, env: Record<string, string>, found: (line: string) => string | undefined): Promise<string> {
  const child = spawn(process.execPath, ['--import', 'tsx', `src/${entry}`], { cwd: `${APPS}${app}`, env: { ...process.env, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  // The apps log to stdout (#143): on a failed start, the error shows the last of it.
  let seen = '';
  const tail = () => (seen === '' ? '' : `; last output:\n${seen}`);
  child.stdout.on('data', (d: Buffer) => {
    seen = (seen + String(d)).slice(-2000);
  });
  child.stderr.on('data', (d: Buffer) => process.stderr.write(`[${app}] ${String(d)}`));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${app} did not start within 40 s${tail()}`));
    }, 40_000);
    child.stdout.on('data', (d: Buffer) => {
      for (const line of String(d).split('\n')) {
        const value = found(line);
        if (value === undefined) continue;
        clearTimeout(timer);
        resolve(value);
      }
    });
    child.once('exit', (code) => {
      reject(new Error(`${app} exited early with ${String(code)}${tail()}`));
    });
  });
}

beforeAll(async () => {
  const mcp = await start('mcp-server', 'local.ts', { MCP_CLIENTS: `agent@demo#*=${TOKEN}`, MCP_SCENARIO: 'clear-day', MCP_SCENARIO_START_H: '14' }, (line) => /listening on ([^"\s]+)/.exec(line)?.[1]);
  const agentPort = await start('agent', 'agentcore-entry.ts', { HOST: '127.0.0.1', AGENT_MODEL_PROVIDER: 'fake', AGENT_MCP_URL: mcp, AGENT_MCP_TOKEN: TOKEN }, (line) =>
    line.includes('"listening"') ? String((JSON.parse(line) as { details: { port: number } }).details.port) : undefined,
  );

  // The stand-in for AgentCore: forwards the payload to the container; a container 4xx/5xx becomes a 424.
  agentCore = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      if (!/^\/runtimes\/[^/]+\/invocations/.test(req.url ?? '') || req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      // `failContainer` plays a container that crashed (a 5xx from inside): AgentCore answers 424.
      const upstream = failContainer
        ? new Response('', { status: 502 })
        : await fetch(`http://127.0.0.1:${agentPort}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
      const text = await upstream.text();
      if (!upstream.ok) {
        res.writeHead(424, { 'content-type': 'application/json', 'x-amzn-ErrorType': 'RuntimeClientError' }).end(JSON.stringify({ message: 'Received error from runtime' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(text);
    })();
  });
  await new Promise<void>((resolve) => agentCore?.listen(0, '127.0.0.1', resolve));
  agentCoreUrl = `http://127.0.0.1:${String((agentCore.address() as AddressInfo).port)}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (agentCore)
      agentCore.close(() => {
        resolve();
      });
    else resolve();
  });
  for (const child of children) child.kill();
});

function adapter() {
  const logs: LogEntry[] = [];
  const client = new BedrockAgentCoreClient({ region: 'us-east-1', endpoint: agentCoreUrl, credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 });
  return { port: agentCoreTurnAgent({ runtimeArn: ARN, timeoutMs: 20_000, client, log: (line) => logs.push(line) }), logs };
}

describe('sim-api -> AgentCore -> agent -> MCP server (local stand-ins for AWS)', () => {
  it('answers "What\'s my battery level?" through InvokeAgentRuntime', async () => {
    failContainer = false;
    const reply = await adapter().port.ask({ home: HOME, question: "What's my battery level?", correlationId: crypto.randomUUID() });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.value.text).toMatch(/\d+ ?%/);
  }, 60_000);

  it('turns a container failure (424 RuntimeClientError) into agent_unavailable, logged with the status', async () => {
    failContainer = true;
    const { port, logs } = adapter();
    const correlationId = crypto.randomUUID();
    expect(await port.ask({ home: HOME, question: 'Hi', correlationId })).toMatchObject({ ok: false, error: { code: 'agent_unavailable', category: 'dependency_unavailable' } });
    expect(logs).toMatchObject([{ level: 'warn', code: 'agent_unavailable', correlationId, errorName: 'RuntimeClientError', details: { httpStatus: 424 } }]);
  }, 60_000);
});
