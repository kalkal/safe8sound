import { randomUUID } from 'node:crypto';
import {
  PROBLEM_JSON_CONTENT_TYPE,
  PhoneInboxSchema,
  toProblemDetails,
  toolError,
  type ErrorEnvelope,
  type HomeId,
  type HttpErrorStatus,
  type InboxMessage,
  type Result,
} from '@cold-reserve/contracts';
import { bearerAuthenticator } from './auth.js';
import type { ClientGrant, ServerConfig } from './config.js';
import type { Logger, McpHandler } from './handler.js';

// GET /phone/inbox (#24, approved by the main): the family phone reads the messages delivered to its
// home. The messages carry the contact's name, so only a phone-scoped token opens it, never an MCP
// client's, and no MCP tool exposes it. Served by the local entry only, not on the Lambda until a
// separate review.

export const PHONE_INBOX_PATH = '/phone/inbox';

export interface PhoneInboxDeps {
  readonly inbox: (homeId: HomeId) => Promise<Result<InboxMessage[], ErrorEnvelope>>;
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

  return async (req) => {
    const correlationId = randomUUID();
    const origin = req.headers.get('origin');
    const cors: Record<string, string> = origin !== null && allowedOrigins.has(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
    const problem = (error: ErrorEnvelope, status?: HttpErrorStatus, headers: Record<string, string> = {}) => {
      const body = toProblemDetails(error, { instance: `urn:uuid:${correlationId}`, ...(status === undefined ? {} : { status }) });
      return new Response(JSON.stringify(body), { status: body.status, headers: { 'content-type': PROBLEM_JSON_CONTENT_TYPE, ...cors, ...headers } });
    };

    if (origin !== null && !allowedOrigins.has(origin)) {
      return problem(toolError('origin_not_allowed', 'The request Origin is not in the allowlist.'));
    }
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'authorization', 'access-control-max-age': '600' } });
    }
    if (req.method !== 'GET') {
      return problem(toolError('method_not_allowed', 'The phone inbox accepts GET only.'), 405, { allow: 'GET, OPTIONS' });
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

    const listed = await deps.inbox(grant.homeId);
    if (!listed.ok) {
      log(listed.error, correlationId, grant);
      return problem(listed.error);
    }
    const body = PhoneInboxSchema.parse({ messages: listed.value });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors } });
  };
}

/** The local entry's router: the phone inbox on its path, everything else to the MCP handler. */
export function createLocalHandler(mcp: McpHandler, phone: McpHandler): McpHandler {
  return (req) => (new URL(req.url).pathname === PHONE_INBOX_PATH ? phone(req) : mcp(req));
}
