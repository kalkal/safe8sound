import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  CORRELATION_ID_HEADER,
  SandboxHomeIdSchema,
  PROBLEM_JSON_CONTENT_TYPE,
  correlationIdFrom,
  toProblemDetails,
  toolError,
  type ErrorEnvelope,
  type HomeId,
  type HttpErrorStatus,
  type Result,
  type TurnReply,
} from '@cold-reserve/contracts';
import { z } from 'zod';
import { logLine, type AgentLogEntry } from './log.js';

// The agent's HTTP entry in the AgentCore runtime shape (POST /invocations, GET /ping, approved in
// #101). Locally on the loopback; sim-api is its only caller, with AGENT_INVOKE_TOKEN.

/** One sandbox home's agent: its own conversation history and its own MCP session. */
export interface HomeAgent {
  ask(question: string, correlationId: string): Promise<Result<TurnReply, ErrorEnvelope>>;
}

const InvocationSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(500),
  /** Invocations serve visitor sandboxes only: the real home is never reachable from here. */
  home: SandboxHomeIdSchema,
  correlationId: z.uuid().optional(),
});

const sha256 = (value: string) => createHash('sha256').update(value).digest();

export function createInvocationHandler(deps: {
  invokeToken: string;
  maxBodyBytes: number;
  agentFor: (home: HomeId) => HomeAgent;
  /** Refusals only: turn failures are logged by the agent itself. */
  log?: (entry: AgentLogEntry) => void;
}): (req: Request) => Promise<Response> {
  const expected = sha256(deps.invokeToken);
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fail = (error: ErrorEnvelope, correlationId: string, status?: HttpErrorStatus) => {
    const body = toProblemDetails(error, { instance: `urn:uuid:${correlationId}`, ...(status === undefined ? {} : { status }) });
    return json(body.status, body, { 'content-type': PROBLEM_JSON_CONTENT_TYPE });
  };

  const refuse = (error: ErrorEnvelope, correlationId: string, status?: HttpErrorStatus) => {
    deps.log?.(logLine(error, 'InvocationRefused', { correlationId }));
    return fail(error, correlationId, status);
  };

  return async (req) => {
    // The turn id from sim-api (header or body); a new one when the caller sent none or a bad one.
    const correlationId = correlationIdFrom(req.headers.get(CORRELATION_ID_HEADER), randomUUID);
    const path = new URL(req.url).pathname;
    if (path === '/ping' && req.method === 'GET') return json(200, { status: 'Healthy' });
    if (path !== '/invocations') return refuse(toolError('route_not_found', 'Unknown endpoint.'), correlationId, 404);
    if (req.method !== 'POST') return refuse(toolError('method_not_allowed', 'POST only.'), correlationId, 405);

    const bearer = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
    if (bearer === undefined) return refuse(toolError('missing_token', 'An invoke token is required.'), correlationId);
    if (!timingSafeEqual(sha256(bearer), expected)) return refuse(toolError('wrong_client', 'This caller may not invoke the agent.'), correlationId);

    const declared = Number(req.headers.get('content-length') ?? 0);
    const text = declared > deps.maxBodyBytes ? '' : await req.text();
    if (declared > deps.maxBodyBytes || Buffer.byteLength(text) > deps.maxBodyBytes) return refuse(toolError('payload_too_large', 'The invocation is too large.'), correlationId, 413);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return refuse(toolError('invalid_input', 'The invocation is not valid JSON.'), correlationId);
    }
    const invocation = InvocationSchema.safeParse(raw);
    if (!invocation.success) return refuse(toolError('invalid_input', 'Send {"prompt", "home"} for a sandbox home.'), correlationId);

    const turnId = invocation.data.correlationId ?? correlationId;
    const reply = await deps.agentFor(invocation.data.home).ask(invocation.data.prompt, turnId);
    return reply.ok ? json(200, reply.value) : fail(reply.error, turnId);
  };
}
