import { HomeIdSchema, type LogEntry } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { agentCoreTurnAgent, type AgentCoreClientLike } from '../src/adapters/agentcore.js';

// G1c (#17): sim-api -> the agent on AgentCore Runtime through InvokeAgentRuntime (IAM/SigV4 by the SDK).
// A fake client stands in for AWS: nothing leaves the machine (cost rule).

const ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/cold_reserve_dev_agent-abc123';
const HOME = HomeIdSchema.parse('demo#0123456789abcdef');
const OTHER = HomeIdSchema.parse('demo#fedcba9876543210');
const CID = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';
const body = (value: unknown) => ({ response: { transformToString: () => Promise.resolve(JSON.stringify(value)) } });
const sdkError = (name: string, status?: number) => Object.assign(new Error(`${name}: arn:aws:iam::123456789012:role/x`), { name, ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }) });

function agent(respond: AgentCoreClientLike['send'], timeoutMs = 1000) {
  const sent: { input: Record<string, unknown> }[] = [];
  const logs: LogEntry[] = [];
  const port = agentCoreTurnAgent({
    runtimeArn: ARN,
    timeoutMs,
    client: {
      send: (command, options) => {
        sent.push(command);
        return respond(command, options);
      },
    },
    log: (entry) => logs.push(entry),
  });
  return { port, sent, logs };
}

describe('agentCoreTurnAgent', () => {
  it('invokes the runtime with the turn as JSON and one session per sandbox home, and answers the TurnReply', async () => {
    const { port, sent } = agent(() => Promise.resolve(body({ text: 'Your battery is at 45%.' })));
    expect(await port.ask({ home: HOME, question: "What's my battery level?", correlationId: CID })).toEqual({ ok: true, value: { text: 'Your battery is at 45%.' } });
    await port.ask({ home: HOME, question: 'Again?', correlationId: CID });
    await port.ask({ home: OTHER, question: 'Hi', correlationId: CID });
    const [first, second, third] = sent.map((c) => c.input);
    expect(first).toMatchObject({ agentRuntimeArn: ARN, contentType: 'application/json', accept: 'application/json' });
    expect(JSON.parse(new TextDecoder().decode(first?.['payload'] as Uint8Array))).toEqual({ prompt: "What's my battery level?", home: HOME, correlationId: CID });
    // The same home keeps its session (its conversation); another home never shares it. AgentCore wants 33+ characters.
    expect(String(first?.['runtimeSessionId']).length).toBeGreaterThanOrEqual(33);
    expect(second?.['runtimeSessionId']).toBe(first?.['runtimeSessionId']);
    expect(third?.['runtimeSessionId']).not.toBe(first?.['runtimeSessionId']);
    expect(String(first?.['runtimeSessionId'])).not.toContain('demo#');
  });

  it('turns the 200 failure envelope back into the same error, with a fixed message and the wait time', async () => {
    const { port } = agent(() => Promise.resolve(body({ failed: true, code: 'turn_in_progress', category: 'rate_limited', retryAfterMs: 7000, correlationId: CID })));
    const reply = await port.ask({ home: HOME, question: 'Hi', correlationId: CID });
    expect(reply).toMatchObject({ ok: false, error: { code: 'turn_in_progress', category: 'rate_limited', retryAfterMs: 7000, message: 'Too many questions at once. Wait a moment, then ask again.' } });
  });

  it('turns an envelope that says the agent refused sim-api itself into unexpected_error, logged with the agent code', async () => {
    const { port, logs } = agent(() => Promise.resolve(body({ failed: true, code: 'invalid_input', category: 'validation', correlationId: CID })));
    expect(await port.ask({ home: HOME, question: 'Hi', correlationId: CID })).toMatchObject({ ok: false, error: { code: 'unexpected_error', category: 'internal' } });
    expect(logs).toMatchObject([{ level: 'error', component: 'sim-api', code: 'invalid_input', correlationId: CID, errorName: 'AgentRefused' }]);
  });

  it('maps a 424 RuntimeClientError (the container failed) to agent_unavailable, logged without the SDK text', async () => {
    const { port, logs } = agent(() => Promise.reject(sdkError('RuntimeClientError', 424)));
    expect(await port.ask({ home: HOME, question: 'Hi', correlationId: CID })).toMatchObject({ ok: false, error: { code: 'agent_unavailable', category: 'dependency_unavailable' } });
    expect(logs).toMatchObject([{ level: 'warn', code: 'agent_unavailable', category: 'dependency_unavailable', correlationId: CID, errorName: 'RuntimeClientError', details: { httpStatus: 424 } }]);
    expect(JSON.stringify(logs)).not.toContain('arn:aws');
  });

  it.each([['ThrottlingException', 429], ['ServiceQuotaExceededException', 402], ['InternalServerException', 500], ['RetryableConflictException', 409]])(
    'maps %s (transient) to agent_unavailable',
    async (name, status) => {
      const { port } = agent(() => Promise.reject(sdkError(name, status)));
      expect(await port.ask({ home: HOME, question: 'Hi', correlationId: CID })).toMatchObject({ ok: false, error: { code: 'agent_unavailable' } });
    },
  );

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'])('maps a network failure (%s, no HTTP answer) to agent_unavailable', async (code) => {
    const { port, logs } = agent(() => Promise.reject(Object.assign(new Error(`connect ${code}`), { code })));
    expect(await port.ask({ home: HOME, question: 'Hi', correlationId: CID })).toMatchObject({ ok: false, error: { code: 'agent_unavailable' } });
    expect(logs[0]).toMatchObject({ level: 'warn', errorName: 'Error' });
  });

  it.each([
    ['a server fault with an unknown name', Object.assign(new Error('x'), { name: 'SomethingNewException', $fault: 'server', $metadata: { httpStatusCode: 500 } })],
    ['a 503 without a known name', Object.assign(new Error('x'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } })],
  ])('maps %s (an AWS 5xx) to agent_unavailable (Copilot on #156)', async (_case, error) => {
    const { port } = agent(() => Promise.reject(error));
    expect(await port.ask({ home: HOME, question: 'Hi', correlationId: CID })).toMatchObject({ ok: false, error: { code: 'agent_unavailable' } });
  });

  it('keeps an AWS client fault with an unknown name as unexpected_error (our setup)', async () => {
    const error = Object.assign(new Error('x'), { name: 'SomethingNewException', $fault: 'client', $metadata: { httpStatusCode: 400 } });
    const { port } = agent(() => Promise.reject(error));
    expect(await port.ask({ home: HOME, question: 'Hi', correlationId: CID })).toMatchObject({ ok: false, error: { code: 'unexpected_error' } });
  });

  it('maps an SDK TimeoutError to agent_unavailable', async () => {
    const { port } = agent(() => Promise.reject(Object.assign(new Error('socket timed out'), { name: 'TimeoutError' })));
    expect(await port.ask({ home: HOME, question: 'Hi', correlationId: CID })).toMatchObject({ ok: false, error: { code: 'agent_unavailable' } });
  });

  it('never hides a bug of ours as an AWS problem: a bare TypeError or a non-Error throw is unexpected_error (review of #152)', async () => {
    for (const thrown of [new TypeError("Cannot read properties of undefined (reading 'x')"), 'boom', undefined]) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of the test: a throw that is not an Error
      const { port, logs } = agent(() => Promise.reject(thrown));
      expect(await port.ask({ home: HOME, question: 'Hi', correlationId: CID })).toMatchObject({ ok: false, error: { code: 'unexpected_error', category: 'internal' } });
      expect(logs[0]).toMatchObject({ level: 'error', code: 'unexpected_error' });
    }
  });

  it.each([['AccessDeniedException', 403], ['ValidationException', 400], ['ResourceNotFoundException', 404]])('maps %s (our setup) to unexpected_error, logged at error level', async (name, status) => {
    const { port, logs } = agent(() => Promise.reject(sdkError(name, status)));
    expect(await port.ask({ home: HOME, question: 'Hi', correlationId: CID })).toMatchObject({ ok: false, error: { code: 'unexpected_error', category: 'internal' } });
    expect(logs).toMatchObject([{ level: 'error', code: 'unexpected_error', errorName: name }]);
  });

  it('answers agent_timeout after its own timeout and aborts the call', async () => {
    let aborted = false;
    const { port } = agent(
      (_command, options) =>
        new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener('abort', () => {
            aborted = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
      20,
    );
    expect(await port.ask({ home: HOME, question: 'Hi', correlationId: CID })).toMatchObject({ ok: false, error: { code: 'agent_timeout' } });
    expect(aborted).toBe(true);
  });

  it('refuses a body that is neither a TurnReply nor a failure envelope', async () => {
    const { port } = agent(() => Promise.resolve(body({ answer: 'free form' })));
    expect(await port.ask({ home: HOME, question: 'Hi', correlationId: CID })).toMatchObject({ ok: false, error: { code: 'output_schema_violation' } });
  });
});
