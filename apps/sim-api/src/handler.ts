import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import {
  PROBLEM_JSON_CONTENT_TYPE,
  SessionRequestSchema,
  SpeechRequestSchema,
  ToolCallRequestSchema,
  TurnRequestSchema,
  toProblemDetails,
  toolError,
  type ErrorCategory,
  type ErrorEnvelope,
  type HomeId,
  type PhoneInbox,
  type LogEntry,
  type HttpErrorStatus,
  type Result,
  type SessionReply,
  type ToolCallReply,
  type ToolCallRequest,
  type TurnReply,
} from '@cold-reserve/contracts';
import { CORRELATION_ID_HEADER, SandboxHomeIdSchema, correlationIdFrom } from '@cold-reserve/contracts';
import type { Clock } from '@cold-reserve/core';
import type { SimApiConfig, SpeechEngine } from './config.js';
import { createQuota, type QuotaStore } from './quota.js';
import { signSpeechTicket, verifySpeechTicket } from './speech-ticket.js';
import { signToken, verifyToken, type DemoClaims } from './token.js';

/** The agent behind a turn (AgentCore after S2; the local agent entry until then). */
export interface TurnAgentPort {
  ask(input: { home: HomeId; question: string; correlationId: string }): Promise<Result<TurnReply, ErrorEnvelope>>;
}

/** Card actions to the MCP server: the MCP token lives on this side only (plan §13.2 point 2). */
export interface CardToolPort {
  call(input: { home: HomeId; request: ToolCallRequest; correlationId: string }): Promise<Result<ToolCallReply, ErrorEnvelope>>;
}

/**
 * One log line: the shared LogEntry of L1 (#111, moved here in #143). Never the demo code, the token, the
 * question or the answer: the code is the message, and the demo code id, durations and tool names go under
 * details.
 */
export type LogLine = LogEntry;
/** The line of a refused or failed request (kept as a name for the adapters). */
export type ErrorLine = LogEntry;

/**
 * The mp3 of one reply, or why not. `mayHaveBilled`: the call reached Polly and may have been charged (a
 * timeout, a cut connection), so its characters stay counted (review of #195).
 */
export type SpeechResult = { ok: true; value: Uint8Array } | { ok: false; error: ErrorEnvelope; mayHaveBilled: boolean };

/** Amazon Polly behind the sim-api (F8d, #25): the mp3 of one reply text, or polly_unavailable. */
export interface SpeechPort {
  synthesize(input: { text: string; engine: SpeechEngine; voice: string; correlationId: string }): Promise<SpeechResult>;
}

/** The spoken replies already paid for (S3, approved in #25). Any failure is thrown: the caller logs it and goes on. */
export interface SpeechCachePort {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, audio: Uint8Array): Promise<void>;
}

export interface SimApiDeps {
  readonly agent: TurnAgentPort;
  readonly tools: CardToolPort;
  readonly quota: QuotaStore;
  readonly clock: Clock;
  /** 16 random hex characters for a visitor's sandbox home. */
  readonly randomHex: () => string;
  readonly logger: { log(line: LogEntry): void };
  /** Polly and its cache; without them (or with SIM_SPEECH_ENABLED off) replies carry no ticket. */
  readonly speech?: { readonly synth: SpeechPort; readonly cache: SpeechCachePort };
  /** The sandbox family phone's inbox (#267); without it GET /v1/phone/inbox does not exist. */
  readonly phone?: PhoneInboxPort;
}

/** The messages delivered to a sandbox's family contact, newest first (#267). Their text never enters a log. */
export interface PhoneInboxPort {
  inbox(input: { home: HomeId; correlationId: string }): Promise<Result<PhoneInbox, ErrorEnvelope>>;
}

/** GET: the phone panel polls it with the visitor's session token; no phone token ever reaches the browser (#267). */
const PHONE_INBOX_PATH = '/v1/phone/inbox';

export type SimApiHandler = (req: Request, meta: { clientIp: string }) => Promise<Response>;

const ROUTES = new Set(['/v1/session', '/v1/turns', '/v1/tools/call', '/v1/speech']);
const LOGGED: ReadonlySet<ErrorCategory> = new Set(['internal', 'dependency_unavailable', 'unauthorized', 'rate_limited']);
const nameOf = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

export function createSimApiHandler(config: SimApiConfig, deps: SimApiDeps): SimApiHandler {
  const origins = new Set(config.allowedOrigins);
  const [signingKey] = config.keys;
  if (!signingKey) throw new Error('sim-api needs a signing key');
  // The signing key is secret and already in SSM: it salts the IP hash too (a key rotation only resets the
  // current hour's attempt counts).
  const { engine, voice } = config.speech;
  const speaking = config.speech.enabled && deps.speech !== undefined;
  const quota = createQuota({ store: deps.quota, limits: config.limits, clock: deps.clock, ipSalt: signingKey.material });

  return async (req, meta) => {
    const correlationId = correlationIdFrom(req.headers.get(CORRELATION_ID_HEADER), randomUUID);
    const origin = req.headers.get('origin');
    /** Set only for an allowlisted Origin: CORS headers go back to that origin alone. */
    const allowedOrigin = origin !== null && origins.has(origin) ? origin : undefined;
    const startedMs = deps.clock.now();
    const info = (line: { event: 'turn_answered' | 'card_action_done' | 'speech_served'; codeId: string; tool?: string; cached?: boolean; chars?: number }) => {
      const now = deps.clock.now();
      const { event, ...details } = line;
      deps.logger.log({ ts: new Date(now).toISOString(), level: 'info', component: 'sim-api', message: event, correlationId, details: { ...details, durationMs: now - startedMs } });
    };
    const fail = (error: ErrorEnvelope, status?: HttpErrorStatus, headers: Record<string, string> = {}, codeId?: string) => {
      if (LOGGED.has(error.category)) {
        // A dependency's error name (e.g. DynamoDB throttling), never its text.
        const causeName = quota.causeOf(error);
        deps.logger.log({
          ts: new Date(deps.clock.now()).toISOString(),
          level: error.category === 'internal' ? 'error' : 'warn',
          component: 'sim-api',
          message: error.code,
          correlationId,
          code: error.code,
          category: error.category,
          ...(causeName === undefined ? {} : { errorName: causeName }),
          ...(codeId === undefined ? {} : { details: { codeId } }),
        });
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

    // The cache only saves money: a failure is logged and the answer goes on.
    const cacheFailed = (step: 'get' | 'put', e: unknown) => {
      deps.logger.log({ ts: new Date(deps.clock.now()).toISOString(), level: 'warn', component: 'sim-api', message: 'speech_cache_failed', correlationId, errorName: nameOf(e), details: { step } });
    };
    /**
     * POST /v1/speech (F8d, #25): only the text a ticket was made for, cache first (free), then Polly within
     * the character caps. A failed cache never stops the answer; the audio is never logged, nor the text.
     */
    const speak = async (body: unknown, codeId: string, jti: string): Promise<Response> => {
      if (!speaking) return fail(toolError('polly_unavailable', 'The studio voice is off right now.'), undefined, {}, codeId);
      const request = SpeechRequestSchema.safeParse(body);
      if (!request.success) return fail(toolError('invalid_input', 'Send {"text": "...", "ticket": "..."} only.'));
      const { text, ticket } = request.data;
      if (!verifySpeechTicket(ticket, { jti, text, engine, voice }, config.keys)) return fail(toolError('invalid_input', 'This reply cannot be spoken.'));

      const key = createHash('sha256').update(`${engine}|${voice}|mp3|${text}`).digest('hex');
      let audio: Uint8Array | undefined;
      try {
        audio = await deps.speech.cache.get(key);
      } catch (e) {
        cacheFailed('get', e);
      }
      const cached = audio !== undefined;
      if (audio === undefined) {
        const allowed = await quota.speech(codeId, text.length, (errorName) => {
          deps.logger.log({ ts: new Date(deps.clock.now()).toISOString(), level: 'warn', component: 'sim-api', message: 'speech_refund_failed', correlationId, errorName, details: { codeId } });
        });
        if (!allowed.ok) return fail(allowed.error, undefined, {}, codeId);
        const made = await deps.speech.synth.synthesize({ text, engine, voice, correlationId });
        if (!made.ok) {
          // Polly refused: the characters go back (review of #180), unless the call may have been billed (#195).
          // A failed refund only costs the code some room.
          try {
            if (!made.mayHaveBilled) await quota.refundSpeech(codeId, text.length);
          } catch (e) {
            deps.logger.log({ ts: new Date(deps.clock.now()).toISOString(), level: 'warn', component: 'sim-api', message: 'speech_refund_failed', correlationId, errorName: nameOf(e), details: { codeId } });
          }
          return fail(made.error, undefined, {}, codeId);
        }
        audio = made.value;
        try {
          await deps.speech.cache.put(key, audio);
        } catch (e) {
          cacheFailed('put', e);
        }
      }
      info({ event: 'speech_served', codeId, cached, chars: text.length });
      const h = new Headers({ 'content-type': 'audio/mpeg', 'cache-control': 'private, max-age=3600', 'x-correlation-id': correlationId });
      if (allowedOrigin !== undefined) {
        h.set('access-control-allow-origin', allowedOrigin);
        h.set('access-control-expose-headers', 'x-correlation-id');
      }
      h.append('vary', 'Origin');
      return new Response(audio, { status: 200, headers: h });
    };

    // Last resort: a throw from a port, the quota store or the body never escapes as a raw 500.
    let codeIdOfRequest: string | undefined;
    // #243: on AWS only CloudFront may call: it adds the origin secret, and names the visitor's IP. Without a
    // configured secret (the local entry) there is no check and the socket IP counts.
    const presented = req.headers.get(ORIGIN_SECRET_HEADER);
    const viaCloudFront = config.originSecrets.length > 0 && presented !== null && config.originSecrets.some((s) => sameSecret(s, presented));
    const viewerIp = req.headers.get('x-viewer-ip');
    const clientIp = viaCloudFront && viewerIp !== null && isIp(viewerIp) ? viewerIp : meta.clientIp;

    // The sandbox family phone (#267): the same origin, switch and token rules as a turn, but a read (GET, no body,
    // no quota) of the token's own sandbox only.
    const phoneInbox = async (port: PhoneInboxPort): Promise<Response> => {
      if (origin !== null && allowedOrigin === undefined) return fail(toolError('origin_not_allowed', 'This origin may not call the demo.'));
      if (req.method === 'OPTIONS') {
        return respond(204, null, { 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'authorization, x-correlation-id', 'access-control-max-age': '600' });
      }
      if (req.method !== 'GET') return fail(toolError('method_not_allowed', 'This endpoint accepts GET only.'), 405, { allow: 'GET, OPTIONS' });
      if (!config.demoEnabled) return fail(toolError('demo_disabled', 'The demo is switched off right now.'));
      const bearer = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
      if (bearer === undefined) return fail(toolError('missing_token', 'Enter the demo code first.'), undefined, { 'www-authenticate': 'Bearer realm="sim-api"' });
      const claims = verifyToken(bearer, { keys: config.keys, nowS: deps.clock.now() / 1000, skewS: config.skewS });
      if (!claims.ok) return fail(claims.error, undefined, { 'www-authenticate': 'Bearer realm="sim-api", error="invalid_token"' });
      codeIdOfRequest = claims.value.sub;
      const inbox = await port.inbox({ home: claims.value.home, correlationId });
      if (!inbox.ok) return fail(inbox.error, undefined, {}, claims.value.sub);
      return respond(200, inbox.value, { 'cache-control': 'no-store' });
    };

    const route = async (): Promise<Response> => {
      if (config.originSecrets.length > 0 && !viaCloudFront) {
        // The reason, never the value presented.
        deps.logger.log({
          ts: new Date(deps.clock.now()).toISOString(),
          level: 'warn',
          component: 'sim-api',
          message: 'origin_not_allowed',
          correlationId,
          code: 'origin_not_allowed',
          category: 'forbidden',
          details: { reason: presented === null ? 'origin_secret_missing' : 'origin_secret_wrong' },
        });
        return fail(toolError('origin_not_allowed', 'The demo answers through its website only.'));
      }
      const path = new URL(req.url).pathname;
      if (path === PHONE_INBOX_PATH && deps.phone !== undefined) return phoneInbox(deps.phone);
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
        // One atomic count per attempt BEFORE the code is compared (review of #110): concurrent wrong
        // codes cannot slip past the cap between a check and a later count. A right code gives its attempt
        // back, so only wrong codes count (review of #139).
        const attempt = await quota.codeAttempt(clientIp);
        if (!attempt.ok) return fail(attempt.error);
        if (!attempt.value.allowed) return fail(quota.tooManyAttempts());
        const codeId = config.demoCodes.get(createHash('sha256').update(request.data.code).digest('hex'));
        if (codeId === undefined) return fail(toolError('invalid_demo_code', 'That demo code is not valid.'));
        try {
          await attempt.value.release();
        } catch (e) {
          // The session still opens; the attempt simply stays counted. Never the IP in the log.
          deps.logger.log({ ts: new Date(deps.clock.now()).toISOString(), level: 'warn', component: 'sim-api', message: 'attempt_release_failed', correlationId, errorName: nameOf(e), details: { codeId } });
        }
        const iat = Math.floor(deps.clock.now() / 1000);
        const claims: DemoClaims = { sub: codeId, home: SandboxHomeIdSchema.parse(`demo#${deps.randomHex()}`), iat, exp: iat + config.tokenTtlS, jti: randomUUID() };
        const reply: SessionReply = { token: signToken(claims, signingKey), expiresAt: new Date(claims.exp * 1000).toISOString() };
        return respond(200, reply);
      }

      const bearer = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
      if (bearer === undefined) return fail(toolError('missing_token', 'Enter the demo code first.'), undefined, { 'www-authenticate': 'Bearer realm="sim-api"' });
      const claims = verifyToken(bearer, { keys: config.keys, nowS: deps.clock.now() / 1000, skewS: config.skewS });
      if (!claims.ok) return fail(claims.error, undefined, { 'www-authenticate': 'Bearer realm="sim-api", error="invalid_token"' });
      const { sub: codeId, home, jti } = claims.value;
      codeIdOfRequest = codeId;

      if (path === '/v1/speech') return speak(body, codeId, jti);

      if (path === '/v1/turns') {
        const request = TurnRequestSchema.safeParse(body);
        if (!request.success) return fail(toolError('invalid_input', 'Send {"question": "..."} only.'));
        const allowed = await quota.turn(codeId);
        if (!allowed.ok) return fail(allowed.error, undefined, {}, codeId);
        const reply = await deps.agent.ask({ home, question: request.data.question, correlationId });
        if (!reply.ok) return fail(reply.error, undefined, {}, codeId);
        info({ event: 'turn_answered', codeId });
        // The ticket of this very text, token and voice (approved in #25): only real replies are spoken.
        // The ticket is only ever ours: a speech field the agent sent is dropped (review of #180).
        const answer: TurnReply = { ...reply.value };
        delete answer.speech;
        const speech = speaking ? { speech: { ticket: signSpeechTicket({ jti, text: answer.text, engine, voice }, signingKey) } } : {};
        return respond(200, { ...answer, ...speech });
      }

      const request = ToolCallRequestSchema.safeParse(body);
      if (!request.success) return fail(toolError('invalid_input', 'Only card actions can be called here.'));
      const allowed = await quota.toolCall(codeId);
      if (!allowed.ok) return fail(allowed.error, undefined, {}, codeId);
      const reply = await deps.tools.call({ home, request: request.data, correlationId });
      if (!reply.ok) return fail(reply.error, undefined, {}, codeId);
      info({ event: 'card_action_done', codeId, tool: request.data.name });
      return respond(200, reply.value);
    };

    try {
      return await route();
    } catch (e) {
      const cause = e instanceof Error ? e.cause : undefined;
      deps.logger.log({
        ts: new Date(deps.clock.now()).toISOString(),
        level: 'error',
        component: 'sim-api',
        message: 'unexpected_error',
        correlationId,
        code: 'unexpected_error',
        category: 'internal',
        errorName: nameOf(e),
        ...(codeIdOfRequest === undefined && cause === undefined
          ? {}
          : { details: { ...(codeIdOfRequest === undefined ? {} : { codeId: codeIdOfRequest }), ...(cause === undefined ? {} : { causeName: nameOf(cause) }) } }),
      });
      const body = toProblemDetails(toolError('unexpected_error', 'Something went wrong on our side. Try again in a moment.'), { instance: `urn:uuid:${correlationId}` });
      return respond(body.status, body, { 'content-type': PROBLEM_JSON_CONTENT_TYPE });
    }
  };
}

/** The header CloudFront adds to every /api request (#243): the origin secret, read from SSM at deploy. */
export const ORIGIN_SECRET_HEADER = 'x-origin-verify';

/** Constant time over equal-length digests: the comparison never tells how much of a guess was right. */
function sameSecret(expected: string, presented: string): boolean {
  const digest = (v: string) => createHash('sha256').update(v, 'utf8').digest();
  return timingSafeEqual(digest(expected), digest(presented));
}

/** An IPv4 or IPv6 address as CloudFront writes it, nothing else (it becomes a quota key). */
const isIp = (v: string): boolean => isIP(v) !== 0;
