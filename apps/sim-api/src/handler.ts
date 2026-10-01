import { createHash, randomUUID } from 'node:crypto';
import {
  PROBLEM_JSON_CONTENT_TYPE,
  SessionRequestSchema,
  ToolCallRequestSchema,
  TurnRequestSchema,
  toProblemDetails,
  toolError,
  type ErrorCategory,
  type ErrorEnvelope,
  type HomeId,
  type HttpErrorStatus,
  type Result,
  type SessionReply,
  type ToolCallReply,
  type ToolCallRequest,
  type TurnReply,
} from '@cold-reserve/contracts';
import { HomeIdSchema } from '@cold-reserve/contracts';
import type { Clock } from '@cold-reserve/core';
import type { SimApiConfig } from './config.js';
import { createQuota, type QuotaStore } from './quota.js';
import { signToken, verifyToken, type DemoClaims } from './token.js';

/** The agent behind a turn (AgentCore after S2; the local agent entry until then). */
export interface TurnAgentPort {
  ask(input: { home: HomeId; question: string; correlationId: string }): Promise<Result<TurnReply, ErrorEnvelope>>;
}

/** Card actions to the MCP server: the MCP token lives on this side only (plan §13.2 point 2). */
export interface CardToolPort {
  call(input: { home: HomeId; request: ToolCallRequest; correlationId: string }): Promise<Result<ToolCallReply, ErrorEnvelope>>;
}

/** One line of the error log: never the demo code or the token. */
export interface LogLine {
  ts: string;
  level: 'warn' | 'error';
  component: 'sim-api';
  code: ErrorEnvelope['code'];
  category: ErrorCategory;
  correlationId: string;
  codeId?: string;
  /** Last resort only: the error type and its cause's type, never their messages. */
  errorName?: string;
  causeName?: string;
}

export interface SimApiDeps {
  readonly agent: TurnAgentPort;
  readonly tools: CardToolPort;
  readonly quota: QuotaStore;
  readonly clock: Clock;
  /** 16 random hex characters for a visitor's sandbox home. */
  readonly randomHex: () => string;
  readonly logger: { log(line: LogLine): void };
}

export type SimApiHandler = (req: Request, meta: { clientIp: string }) => Promise<Response>;

const ROUTES = new Set(['/v1/session', '/v1/turns', '/v1/tools/call']);
const LOGGED: ReadonlySet<ErrorCategory> = new Set(['internal', 'dependency_unavailable', 'unauthorized', 'rate_limited']);
const nameOf = (e: unknown): string => (e instanceof Error ? e.name : typeof e);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSimApiHandler(config: SimApiConfig, deps: SimApiDeps): SimApiHandler {
  const quota = createQuota({ store: deps.quota, limits: config.limits, clock: deps.clock });
  const origins = new Set(config.allowedOrigins);
  const [signingKey] = config.keys;
  if (!signingKey) throw new Error('sim-api needs a signing key');

  return async (req, meta) => {
    const presented = req.headers.get('x-correlation-id');
    const correlationId = presented && UUID.test(presented) ? presented : randomUUID();
    const origin = req.headers.get('origin');
    /** Set only for an allowlisted Origin: CORS headers go back to that origin alone. */
    const allowedOrigin = origin !== null && origins.has(origin) ? origin : undefined;
    const fail = (error: ErrorEnvelope, status?: HttpErrorStatus, headers: Record<string, string> = {}, codeId?: string) => {
      if (LOGGED.has(error.category)) {
        deps.logger.log({ ts: new Date(deps.clock.now()).toISOString(), level: error.category === 'internal' ? 'error' : 'warn', component: 'sim-api', code: error.code, category: error.category, correlationId, ...(codeId === undefined ? {} : { codeId }) });
      }
      const body = toProblemDetails(error, { instance: `urn:uuid:${correlationId}`, ...(status === undefined ? {} : { status }) });
      return respond(body.status, body, { 'content-type': PROBLEM_JSON_CONTENT_TYPE, ...headers });
    };
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const h = new Headers({ 'content-type': 'application/json', 'x-correlation-id': correlationId, ...headers });
      if (allowedOrigin !== undefined) {
        h.set('access-control-allow-origin', allowedOrigin);
        h.set('access-control-expose-headers', 'x-correlation-id');
      }
      h.append('vary', 'Origin');
      return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: h });
    };

    // Last resort: a throw from a port, the quota store or the body never escapes as a raw 500.
    let codeIdOfRequest: string | undefined;
    const route = async (): Promise<Response> => {
      const path = new URL(req.url).pathname;
      if (!ROUTES.has(path)) return fail(toolError('route_not_found', 'Unknown endpoint.'), 404);
      if (origin !== null && allowedOrigin === undefined) return fail(toolError('origin_not_allowed', 'This origin may not call the demo.'));
      if (req.method === 'OPTIONS') {
        return respond(204, null, { 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, x-correlation-id', 'access-control-max-age': '600' });
      }
      if (req.method !== 'POST') return fail(toolError('method_not_allowed', 'This endpoint accepts POST only.'), 405, { allow: 'POST, OPTIONS' });
      if (!config.demoEnabled) return fail(toolError('demo_disabled', 'The demo is switched off right now.'));

      const declared = Number(req.headers.get('content-length') ?? 0);
      const text = declared > config.maxBodyBytes ? '' : await req.text();
      if (declared > config.maxBodyBytes || Buffer.byteLength(text) > config.maxBodyBytes) return fail(toolError('payload_too_large', 'The request is too large.'), 413);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return fail(toolError('invalid_input', 'The request is not valid JSON.'));
      }

      if (path === '/v1/session') {
        const request = SessionRequestSchema.safeParse(body);
        if (!request.success) return fail(toolError('invalid_input', 'Send {"code": "<demo code>"}.'));
        if (!(await quota.codeAttemptsLeft(meta.clientIp))) {
          const limited = quota.tooManyAttempts();
          if (!limited.ok) return fail(limited.error);
        }
        const codeId = config.demoCodes.get(createHash('sha256').update(request.data.code).digest('hex'));
        if (codeId === undefined) {
          await quota.failedCode(meta.clientIp);
          return fail(toolError('invalid_demo_code', 'That demo code is not valid.'));
        }
        const iat = Math.floor(deps.clock.now() / 1000);
        const claims: DemoClaims = { sub: codeId, home: HomeIdSchema.parse(`demo#${deps.randomHex()}`), iat, exp: iat + config.tokenTtlS, jti: randomUUID() };
        const reply: SessionReply = { token: signToken(claims, signingKey), expiresAt: new Date(claims.exp * 1000).toISOString() };
        return respond(200, reply);
      }

      const bearer = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
      if (bearer === undefined) return fail(toolError('missing_token', 'Enter the demo code first.'), undefined, { 'www-authenticate': 'Bearer realm="sim-api"' });
      const claims = verifyToken(bearer, { keys: config.keys, nowS: deps.clock.now() / 1000, skewS: config.skewS });
      if (!claims.ok) return fail(claims.error, undefined, { 'www-authenticate': 'Bearer realm="sim-api", error="invalid_token"' });
      const { sub: codeId, home } = claims.value;
      codeIdOfRequest = codeId;

      if (path === '/v1/turns') {
        const request = TurnRequestSchema.safeParse(body);
        if (!request.success) return fail(toolError('invalid_input', 'Send {"question": "..."} only.'));
        const allowed = await quota.turn(codeId);
        if (!allowed.ok) return fail(allowed.error, undefined, {}, codeId);
        const reply = await deps.agent.ask({ home, question: request.data.question, correlationId });
        return reply.ok ? respond(200, reply.value) : fail(reply.error, undefined, {}, codeId);
      }

      const request = ToolCallRequestSchema.safeParse(body);
      if (!request.success) return fail(toolError('invalid_input', 'Only card actions can be called here.'));
      const allowed = await quota.toolCall(codeId);
      if (!allowed.ok) return fail(allowed.error, undefined, {}, codeId);
      const reply = await deps.tools.call({ home, request: request.data, correlationId });
      return reply.ok ? respond(200, reply.value) : fail(reply.error, undefined, {}, codeId);
    };

    try {
      return await route();
    } catch (e) {
      const cause = e instanceof Error ? e.cause : undefined;
      deps.logger.log({
        ts: new Date(deps.clock.now()).toISOString(),
        level: 'error',
        component: 'sim-api',
        code: 'unexpected_error',
        category: 'internal',
        correlationId,
        ...(codeIdOfRequest === undefined ? {} : { codeId: codeIdOfRequest }),
        errorName: nameOf(e),
        ...(cause === undefined ? {} : { causeName: nameOf(cause) }),
      });
      const body = toProblemDetails(toolError('unexpected_error', 'Something went wrong on our side. Try again in a moment.'), { instance: `urn:uuid:${correlationId}` });
      return respond(body.status, body, { 'content-type': PROBLEM_JSON_CONTENT_TYPE });
    }
  };
}
