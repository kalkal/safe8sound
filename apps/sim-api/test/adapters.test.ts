import { HomeIdSchema, ToolCallRequestSchema, toolError, toProblemDetails } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { httpTurnAgent } from '../src/adapters/agent-http.js';
import { mcpCardTools, type McpCaller } from '../src/adapters/mcp-cards.js';

const HOME = HomeIdSchema.parse('demo#0123456789abcdef');
const CID = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';
const APPLY = ToolCallRequestSchema.parse({ name: 'apply_plan', arguments: { planId: 'plan-0001' } });

describe('httpTurnAgent: sim-api -> agent POST /invocations (AgentCore shape)', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const agent = (respond: () => Promise<Response>, timeoutMs = 1000) =>
    httpTurnAgent({
      url: 'http://127.0.0.1:3340',
      invokeToken: 'i'.repeat(48),
      timeoutMs,
      fetchFn: (url, init) => {
        calls.push({ url, init });
        return respond();
      },
    });

  it('sends the prompt, the home from the token and the correlation id, with the invoke token', async () => {
    calls.length = 0;
    const reply = await agent(() => Promise.resolve(Response.json({ text: 'Battery at 45%.' }))).ask({ home: HOME, question: 'Battery?', correlationId: CID });
    expect(reply).toEqual({ ok: true, value: { text: 'Battery at 45%.' } });
    expect(calls[0]?.url).toBe('http://127.0.0.1:3340/invocations');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ prompt: 'Battery?', home: HOME, correlationId: CID });
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe(`Bearer ${'i'.repeat(48)}`);
  });

  it('passes the agent Problem Details on as the same error', async () => {
    const problem = toProblemDetails(toolError('agent_timeout', 'Too slow.'), { instance: `urn:uuid:${CID}` });
    const reply = await agent(() => Promise.resolve(Response.json(problem, { status: 503 }))).ask({ home: HOME, question: 'Hi', correlationId: CID });
    expect(reply).toMatchObject({ ok: false, error: { code: 'agent_timeout', retryable: true } });
  });

  it('turns an agent refusal (bad invoke token, bad invocation) into unexpected_error for the browser, and logs the agent code (review of #139)', async () => {
    for (const [code, status] of [['wrong_client', 401], ['missing_token', 401], ['invalid_input', 400], ['route_not_found', 404]] as const) {
      const logs: object[] = [];
      const refused = toProblemDetails(toolError(code, 'Refused.'), { instance: `urn:uuid:${CID}` });
      const port = httpTurnAgent({ url: 'http://127.0.0.1:3340', invokeToken: 'i'.repeat(48), timeoutMs: 1000, fetchFn: () => Promise.resolve(Response.json(refused, { status })), log: (line) => logs.push(line) });
      const reply = await port.ask({ home: HOME, question: 'Hi', correlationId: CID });
      expect(reply, code).toMatchObject({ ok: false, error: { code: 'unexpected_error', category: 'internal' } });
      expect(logs, code).toMatchObject([{ level: 'error', component: 'sim-api', code, correlationId: CID, errorName: 'AgentRefused' }]);
    }
  });

  it('passes rate limits on with their wait time', async () => {
    const busy = toProblemDetails(toolError('turn_in_progress', 'Wait.', { retryAfterMs: 7000 }), { instance: `urn:uuid:${CID}` });
    const reply = await agent(() => Promise.resolve(Response.json(busy, { status: 429 }))).ask({ home: HOME, question: 'Hi', correlationId: CID });
    expect(reply).toMatchObject({ ok: false, error: { code: 'turn_in_progress', category: 'rate_limited', retryAfterMs: 7000 } });
  });

  it('keeps the code but never forwards the agent detail text: a fixed, safe message per category (review of #110)', async () => {
    const leaky = toProblemDetails(toolError('agent_unavailable', 'User: arn:aws:sts::123456789012:assumed-role/x is not authorized'), { instance: `urn:uuid:${CID}` });
    const reply = await agent(() => Promise.resolve(Response.json(leaky, { status: 503 }))).ask({ home: HOME, question: 'Hi', correlationId: CID });
    expect(reply).toMatchObject({ ok: false, error: { code: 'agent_unavailable', message: 'The assistant is not available right now. Try again in a moment.' } });
    expect(JSON.stringify(reply)).not.toContain('arn:aws');
  });

  it('answers agent_timeout after its own timeout and agent_unavailable when the agent is down', async () => {
    const slow = await agent(() => new Promise<Response>(() => undefined), 20).ask({ home: HOME, question: 'Hi', correlationId: CID });
    expect(slow).toMatchObject({ ok: false, error: { code: 'agent_timeout' } });
    const down = await agent(() => Promise.reject(new TypeError('fetch failed'))).ask({ home: HOME, question: 'Hi', correlationId: CID });
    expect(down).toMatchObject({ ok: false, error: { code: 'agent_unavailable', retryable: true } });
  });

  it('refuses a reply that breaks the turn contract', async () => {
    const reply = await agent(() => Promise.resolve(Response.json({ answer: 'x' }))).ask({ home: HOME, question: 'Hi', correlationId: CID });
    expect(reply).toMatchObject({ ok: false, error: { code: 'output_schema_violation' } });
  });
});

describe('mcpCardTools: card actions to the MCP server, with the sandbox home of the token', () => {
  it('calls the tool for the home and answers the CallToolResult a card expects', async () => {
    const seen: { home: string; name: string; args: unknown; correlationId: string }[] = [];
    const caller: McpCaller = (home, name, args, _signal, correlationId) => {
      seen.push({ home, name, args, correlationId });
      return Promise.resolve({ content: [{ type: 'text', text: 'Applied.' }], structuredContent: { alreadyApplied: false } });
    };
    const tools = mcpCardTools({ caller, timeoutMs: 1000 });
    const reply = await tools.call({ home: HOME, request: APPLY, correlationId: CID });
    expect(reply).toEqual({ ok: true, value: { content: [{ type: 'text', text: 'Applied.' }], structuredContent: { alreadyApplied: false } } });
    expect(seen).toEqual([{ home: HOME, name: 'apply_plan', args: { planId: 'plan-0001' }, correlationId: CID }]);
  });

  it('keeps a tool error as a value for the card (isError + envelope)', async () => {
    const envelope = toolError('plan_expired', 'The plan expired.');
    const caller: McpCaller = () => Promise.resolve({ isError: true, content: [{ type: 'text', text: envelope.message }], structuredContent: envelope });
    const reply = await mcpCardTools({ caller, timeoutMs: 1000 }).call({ home: HOME, request: APPLY, correlationId: CID });
    expect(reply).toMatchObject({ ok: true, value: { isError: true, structuredContent: { code: 'plan_expired' } } });
  });

  it('answers agent_unavailable when the MCP server cannot be reached, and after its timeout', async () => {
    const down = mcpCardTools({ caller: () => Promise.reject(new TypeError('fetch failed')), timeoutMs: 1000 });
    expect(await down.call({ home: HOME, request: APPLY, correlationId: CID })).toMatchObject({ ok: false, error: { code: 'agent_unavailable' } });
    const slow = mcpCardTools({ caller: () => new Promise(() => undefined), timeoutMs: 20 });
    expect(await slow.call({ home: HOME, request: APPLY, correlationId: CID })).toMatchObject({ ok: false, error: { code: 'agent_timeout' } });
  });
});
