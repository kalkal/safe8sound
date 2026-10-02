import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { ProblemDetailsSchema, SessionReplySchema, TurnReplySchema, ok, type LogEntry } from '@cold-reserve/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSimApiLambda, type FunctionUrlEvent } from '../../src/lambda.js';
import { loadSimApiLambda } from '../../src/lambda-wiring.js';
import { memoryQuotaStore } from '../../src/quota.js';

// The sim-api Lambda flow end to end (#17, the sim-api stack), without AWS: a Function URL event -> the
// Lambda entry -> the real wiring (secrets from a stub SSM reader) -> the real AWS SDK client (fake
// credentials) -> a local stand-in for AgentCore. The daily cap and a failing runtime are injected.

const ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/cold_reserve_dev_agent-AbCdEf1234';
const CODE = 'judges-demo-code-2026';
const ORIGIN = 'https://sim.example';
let standIn: Server | undefined;
let standInUrl = '';
let runtimeFails = false;

beforeAll(async () => {
  standIn = createServer((req, res) => {
    void (async () => {
      req.resume();
      await new Promise((resolve) => req.once('end', resolve));
      if (runtimeFails) {
        res.writeHead(424, { 'content-type': 'application/json', 'x-amzn-ErrorType': 'RuntimeClientError' }).end(JSON.stringify({ message: 'Received error from runtime' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: 'Your battery is at 64%.' }));
    })();
  });
  await new Promise<void>((resolve) => standIn?.listen(0, '127.0.0.1', resolve));
  standInUrl = `http://127.0.0.1:${String((standIn.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (standIn)
      standIn.close(() => {
        resolve();
      });
    else resolve();
  });
});

function lambda(turnsPerCode: number) {
  const logs: LogEntry[] = [];
  const log = (entry: LogEntry) => logs.push(entry);
  const secrets: Record<string, string> = {
    '/cold-reserve/dev/sim-api/demo-codes': `judges:${createHash('sha256').update(CODE).digest('hex')}`,
    '/cold-reserve/dev/sim-api/token-keys': `k1:${Buffer.alloc(32, 9).toString('base64url')}`,
    '/cold-reserve/dev/sim-api/mcp-token': 'm'.repeat(40),
  };
  const env = {
    SIM_DEMO_CODES_PARAMETER: '/cold-reserve/dev/sim-api/demo-codes',
    SIM_TOKEN_KEYS_PARAMETER: '/cold-reserve/dev/sim-api/token-keys',
    SIM_MCP_TOKEN_PARAMETER: '/cold-reserve/dev/sim-api/mcp-token',
    SIM_ALLOWED_ORIGINS: ORIGIN,
    SIM_LIMIT_TURNS_PER_CODE: String(turnsPerCode),
    AGENT_RUNTIME_ARN: ARN,
    SIM_AGENT_TIMEOUT_MS: '5000',
    SIM_MCP_URL: 'http://127.0.0.1:39999/mcp',
    STATE_TABLE_NAME: 'ColdReserve-dev',
    AWS_REGION: 'us-east-1',
  };
  const agentCore = new BedrockAgentCoreClient({ region: 'us-east-1', endpoint: standInUrl, credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 });
  const handler = createSimApiLambda(
    () => loadSimApiLambda(env, { read: (name) => Promise.resolve(ok(secrets[name] ?? '')), agentCore, quotaFor: () => memoryQuotaStore(), log, clock: { now: Date.now } }),
    { log },
  );
  return { handler, logs };
}

const post = (path: string, body: unknown, token?: string): FunctionUrlEvent => ({
  rawPath: path,
  rawQueryString: '',
  headers: { 'content-type': 'application/json', origin: ORIGIN, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
  body: JSON.stringify(body),
  isBase64Encoded: false,
  requestContext: { domainName: 'abc.lambda-url.us-east-1.on.aws', http: { method: 'POST', sourceIp: '203.0.113.7' } },
});

describe('sim-api Lambda: Function URL event -> wiring -> AgentCore (local stand-in)', () => {
  it('opens a session with the demo code and answers a turn through InvokeAgentRuntime, then stops at the daily cap', async () => {
    runtimeFails = false;
    const { handler } = lambda(1);
    const session = await handler(post('/v1/session', { code: CODE }));
    expect(session.statusCode).toBe(200);
    expect(session.headers['access-control-allow-origin']).toBe(ORIGIN);
    const { token } = SessionReplySchema.parse(JSON.parse(session.body));

    const turn = await handler(post('/v1/turns', { question: "What's my battery level?" }, token));
    expect(turn.statusCode).toBe(200);
    expect(TurnReplySchema.parse(JSON.parse(turn.body)).text).toContain('64%');

    const capped = await handler(post('/v1/turns', { question: 'And now?' }, token));
    expect(capped.statusCode).toBe(429);
    expect(ProblemDetailsSchema.parse(JSON.parse(capped.body)).code).toBe('demo_quota_exceeded');
  }, 30_000);

  it('answers a failing runtime (424 RuntimeClientError) as 503 agent_unavailable, logged with the correlation id', async () => {
    runtimeFails = true;
    const { handler, logs } = lambda(5);
    const { token } = SessionReplySchema.parse(JSON.parse((await handler(post('/v1/session', { code: CODE }))).body));
    const failed = await handler(post('/v1/turns', { question: 'Hi' }, token));
    expect(failed.statusCode).toBe(503);
    const problem = ProblemDetailsSchema.parse(JSON.parse(failed.body));
    expect(problem.code).toBe('agent_unavailable');
    const correlationId = failed.headers['x-correlation-id'];
    expect(logs).toContainEqual(expect.objectContaining({ code: 'agent_unavailable', correlationId, errorName: 'RuntimeClientError' }));
  }, 30_000);
});
