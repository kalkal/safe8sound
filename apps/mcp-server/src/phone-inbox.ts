import { randomUUID } from 'node:crypto';
import {
  CORRELATION_ID_HEADER,
  HOME_HEADER,
  PROBLEM_JSON_CONTENT_TYPE,
  PhoneInboxSchema,
  PhoneReplyInputSchema,
  PhoneReplyOutputSchema,
  SandboxHomeIdSchema,
  correlationIdFrom,
  toProblemDetails,
  toolError,
  type ErrorEnvelope,
  type HomeId,
  type HttpErrorStatus,
  type InboxMessage,
  type PhoneReply,
  type PhoneReplyOutput,
  type Result,
} from '@cold-reserve/contracts';
import { bearerAuthenticator } from './auth.js';
import type { ClientGrant, ServerConfig } from './config.js';
import type { Logger, McpHandler } from './handler.js';
import { homeDetail } from './sandbox-log.js';
import type { ToolContext } from './tool.js';

// GET /phone/inbox (#24): the family phone reads the messages delivered to its home. The messages carry the
// contact's name, so only a phone-scoped token opens it, never an MCP client's, and no MCP tool exposes it.
// Visitor sandboxes (#267, approved in #267): a phone token granted for `demo#*` reads the sandbox named by
// x-cold-reserve-home (sandbox ids only, never demo or the real home), read-only; it is held by sim-api, which
// serves the visitor's phone panel, so the route is served on the Lambda too. Every read leaves one log line,
// with neither the sandbox id nor any message text.

export const PHONE_INBOX_PATH = '/phone/inbox';
/** POST /phone/reply (queue item 3, #24): "I'm on my way" or "Check status", by the phone's own role. */
export const PHONE_REPLY_PATH = '/phone/reply';
/** A reply body is one word of a closed set: anything larger is refused before it is parsed. */
const MAX_REPLY_BYTES = 256;

/** Records a reply for the phone's role (the token's client id) and home; storm mode's familyReply. */
export type PhoneReplyHandler = (input: { reply: PhoneReply }, ctx: ToolContext) => Promise<Result<PhoneReplyOutput, ErrorEnvelope>>;

export interface PhoneInboxDeps {
  readonly inbox: (homeId: HomeId) => Promise<Result<InboxMessage[], ErrorEnvelope>>;
  /** Absent without the storm module: the reply path is then not served. */
  readonly reply?: PhoneReplyHandler;
  /**
   * Admits a visitor sandbox before its inbox is read, as an MCP request does (#267): its playthrough, hence its
   * store scope, is known in this container. Without it a sandbox phone token reads nothing.
   */
  readonly admit?: (homeId: HomeId, correlationId: string) => Promise<Result<void, ErrorEnvelope>>;
  readonly logger: Logger;
}

export function createPhoneInboxHandler(config: ServerConfig, deps: PhoneInboxDeps): McpHandler {
  const bearer = bearerAuthenticator(config.clients);
  const allowedOrigins = new Set(config.allowedOrigins);

  /** undefined = no bearer token; null = a token not issued to a phone. */
  function authenticate(header: string | null): ClientGrant | null | undefined {
    const grant = bearer(header);
    if (grant === undefined) return undefined;
    return grant?.scope === 'phone' ? grant : null;
  }

  function log(error: ErrorEnvelope, correlationId: string, grant?: ClientGrant) {
    deps.logger.log({
      ts: new Date().toISOString(),
      level: error.category === 'internal' ? 'error' : 'warn',
      component: 'mcp-server',
      code: error.code,
      category: error.category,
      message: error.message,
      correlationId,
      ...(grant === undefined ? {} : { homeId: grant.homeId, clientId: grant.clientId }),
    });
  }

  async function readReply(req: Request): Promise<Result<{ reply: PhoneReply }, ErrorEnvelope>> {
    const invalid = toolError('invalid_input', 'Send {"reply": "on_my_way"} or {"reply": "check_status"}.', { details: { field: 'reply' } });
    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_REPLY_BYTES) return { ok: false, error: invalid };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, error: invalid };
    }
    const parsed = PhoneReplyInputSchema.safeParse(body);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: invalid };
  }

  return async (req) => {
    const path = new URL(req.url).pathname;
    const replying = path === PHONE_REPLY_PATH;
    const method = replying ? 'POST' : 'GET';
    const reply = deps.reply;
    // The browser's poll id when it is a UUID, so its log line and ours share one id (review of #169).
    const correlationId = correlationIdFrom(req.headers.get(CORRELATION_ID_HEADER), randomUUID);
    const origin = req.headers.get('origin');
    const cors: Record<string, string> = origin !== null && allowedOrigins.has(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
    const problem = (error: ErrorEnvelope, status?: HttpErrorStatus, headers: Record<string, string> = {}) => {
      const body = toProblemDetails(error, { instance: `urn:uuid:${correlationId}`, ...(status === undefined ? {} : { status }) });
      return new Response(JSON.stringify(body), { status: body.status, headers: { 'content-type': PROBLEM_JSON_CONTENT_TYPE, ...cors, ...headers } });
    };

    // Without the storm module there is nothing to reply to: the path does not exist.
    if (replying && reply === undefined) return problem(toolError('route_not_found', 'No such path.'), 404);
    if (origin !== null && !allowedOrigins.has(origin)) {
      return problem(toolError('origin_not_allowed', 'The request Origin is not in the allowlist.'));
    }
    if (req.method === 'OPTIONS') {
      const headers = replying ? 'authorization, content-type' : 'authorization';
      return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': method, 'access-control-allow-headers': headers, 'access-control-max-age': '600' } });
    }
    if (req.method !== method) {
      return problem(toolError('method_not_allowed', `This phone path accepts ${method} only.`), 405, { allow: `${method}, OPTIONS` });
    }

    const grant = authenticate(req.headers.get('authorization'));
    if (grant === undefined) {
      const error = toolError('missing_token', 'Send Authorization: Bearer <token>.');
      log(error, correlationId);
      return problem(error, undefined, { 'www-authenticate': 'Bearer realm="phone"' });
    }
    if (grant === null) {
      const error = toolError('wrong_client', 'The token was not issued for the family phone.');
      log(error, correlationId);
      return problem(error, undefined, { 'www-authenticate': 'Bearer realm="phone", error="invalid_token"' });
    }

    // The home: the token's own, or for a sandbox phone the visitor sandbox it names (#267).
    let homeId = grant.homeId;
    const requested = req.headers.get(HOME_HEADER);
    if (grant.sandboxes === true) {
      const sandbox = SandboxHomeIdSchema.safeParse(requested);
      if (!sandbox.success || deps.admit === undefined) {
        const error = toolError('home_not_allowed', 'Name a visitor sandbox in x-cold-reserve-home.');
        log(error, correlationId, grant);
        return problem(error);
      }
      // Read-only: a sandbox phone never replies.
      if (replying) return problem(toolError('route_not_found', 'No such path.'), 404);
      const admitted = await deps.admit(sandbox.data, correlationId);
      if (!admitted.ok) {
        log(admitted.error, correlationId, grant);
        return problem(admitted.error);
      }
      homeId = sandbox.data;
    } else if (requested !== null && requested !== grant.homeId) {
      const error = toolError('home_not_allowed', 'This phone may not read that home.');
      log(error, correlationId, grant);
      return problem(error);
    }

    if (replying && reply !== undefined) {
      const input = await readReply(req);
      if (!input.ok) {
        log(input.error, correlationId, grant);
        return problem(input.error);
      }
      const recorded = await reply(input.value, { correlationId, clientId: grant.clientId, homeId: grant.homeId });
      if (!recorded.ok) {
        log(recorded.error, correlationId, grant);
        const retry = recorded.error.retryAfterMs === undefined ? {} : { 'retry-after': String(Math.ceil(recorded.error.retryAfterMs / 1000)) };
        return problem(recorded.error, undefined, retry);
      }
      const body = PhoneReplyOutputSchema.parse(recorded.value);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors } });
    }

    const listed = await deps.inbox(homeId);
    if (!listed.ok) {
      log(listed.error, correlationId, grant);
      return problem(listed.error);
    }
    // Every read, counted, never the text; a sandbox as `sandbox`, never its id (#267).
    deps.logger.log({
      ts: new Date().toISOString(),
      level: 'info',
      component: 'mcp-server',
      message: 'phone_inbox_read',
      correlationId,
      details: { clientId: grant.clientId, messages: listed.value.length, ...homeDetail(homeId) },
    });
    const body = PhoneInboxSchema.parse({ messages: listed.value });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors } });
  };
}

/** The local entry's router: the phone paths to the phone handler, everything else to the MCP handler. */
export function createLocalHandler(mcp: McpHandler, phone: McpHandler): McpHandler {
  const phonePaths = new Set([PHONE_INBOX_PATH, PHONE_REPLY_PATH]);
  return (req) => (phonePaths.has(new URL(req.url).pathname) ? phone(req) : mcp(req));
}
