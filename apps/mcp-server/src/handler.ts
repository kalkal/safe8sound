import { randomUUID } from 'node:crypto';
import {
  ASKED_BY_PERSON_META,
  CORRELATION_ID_HEADER,
  HOME_HEADER,
  TURN_HEADER,
  PROBLEM_JSON_CONTENT_TYPE,
  SandboxHomeIdSchema,
  correlationIdFrom,
  turnIdFrom,
  toProblemDetails,
  toolError,
  type ErrorCategory,
  type ErrorEnvelope,
  type HttpErrorStatus,
} from '@cold-reserve/contracts';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode as RpcErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { bearerAuthenticator } from './auth.js';
import { READ_SCOPE_TOOLS, type ServerConfig } from './config.js';
import type { ModuleRegistry, UiResource } from './registry.js';
import type { Sandboxes } from './sandboxes.js';
import { listTool, type HintedError, type ToolContext, type ToolDefinition } from './tool.js';

// One log line for every component: the shared LogEntry of contracts and the Logger port of core (#111).
export type { LogEntry } from '@cold-reserve/contracts';
export type { Logger } from '@cold-reserve/core';
import type { Logger } from '@cold-reserve/core';
import { homeDetail, isSandbox } from './sandbox-log.js';

export interface HandlerDeps {
  readonly registry: ModuleRegistry;
  readonly logger: Logger;
  /** Visitor sandboxes (#101): without it, no request can name a home. */
  readonly sandboxes?: Sandboxes<unknown>;
  /** Where the per-tool latency metric goes (EMF JSON lines on Lambda); none locally (G6, #146). */
  readonly metrics?: (line: Record<string, unknown>) => void;
  /** Monotonic clock for durations, in ms; `performance.now` by default. */
  readonly now?: () => number;
}

const PRM_PREFIX = '/.well-known/oauth-protected-resource';

/** Where the metadata document of a resource lives: the well-known prefix before the resource's path. */
const metadataUrl = (resource: string, path: string): string => new URL(PRM_PREFIX + path, resource).href;

/**
 * The OAuth 2.0 Protected Resource Metadata document (RFC 9728, G4 step 1, #149): public, static, from config.
 * Alexa does not read WWW-Authenticate on a 401, so this well-known path is how it finds out how to authenticate.
 */
/** The canonical URL of the resource: the configured one, or in auto mode the origin the request reached plus the MCP path. */
const resourceUrl = (pr: NonNullable<ServerConfig['protectedResource']>, req: Request, path: string): string =>
  pr.resource === 'auto' ? new URL(path, new URL(req.url).origin).href : pr.resource;

function protectedResourceMetadata(req: Request, correlationId: string, pr: NonNullable<ServerConfig['protectedResource']>, path: string): Response {
  if (req.method !== 'GET') {
    const body = toProblemDetails(toolError('method_not_allowed', 'The metadata document answers GET only.'), { instance: `urn:uuid:${correlationId}`, status: 405 });
    return new Response(JSON.stringify(body), { status: 405, headers: { 'content-type': PROBLEM_JSON_CONTENT_TYPE, allow: 'GET' } });
  }
  const doc = {
    resource: resourceUrl(pr, req, path),
    ...(pr.authorizationServers.length === 0 ? {} : { authorization_servers: pr.authorizationServers }),
    bearer_methods_supported: ['header'],
  };
  return new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' } });
}

export type ToolCallOutcome = 'ok' | 'error';


/**
 * One latency sample in CloudWatch Embedded Metric Format: a JSON line of its own, because EMF needs its
 * fields at the top level and the shared log line is strict (G6, #146).
 */
export function toolCallMetric(m: { namespace: string; tool: string; outcome: ToolCallOutcome; durationMs: number; atMs: number }): Record<string, unknown> {
  return {
    _aws: {
      Timestamp: m.atMs,
      CloudWatchMetrics: [{ Namespace: m.namespace, Dimensions: [['Tool']], Metrics: [{ Name: 'ToolLatency', Unit: 'Milliseconds' }] }],
    },
    Tool: m.tool,
    Outcome: m.outcome,
    ToolLatency: m.durationMs,
  };
}

export type McpHandler = (req: Request) => Promise<Response>;

// Categories kept in the error log (docs/error-handling.md §6.1).
// forbidden and rate_limited too: a refused sandbox header or a full daily cap is worth a line (#101).
const LOGGED: ReadonlySet<ErrorCategory> = new Set(['internal', 'dependency_unavailable', 'guard_rejection', 'unauthorized', 'forbidden', 'rate_limited']);
const MAX_ISSUES = 20;
/** MCP "resource not found" (spec 2025-11-25, server/resources); the SDK has no name for it. */
const RESOURCE_NOT_FOUND = -32002;
/** MCP Apps mime type of a ui:// document. */
export const CARD_MIME_TYPE = 'text/html;profile=mcp-app';

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function problem(error: ErrorEnvelope, correlationId: string, status?: HttpErrorStatus, headers: Record<string, string> = {}): Response {
  const body = toProblemDetails(error, { instance: `urn:uuid:${correlationId}`, ...(status === undefined ? {} : { status }) });
  return new Response(JSON.stringify(body), { status: body.status, headers: { 'content-type': PROBLEM_JSON_CONTENT_TYPE, ...headers } });
}

function errorResult(error: HintedError): CallToolResult {
  // A hint for the model reaches its text only, never the envelope a card shows (#272).
  const { modelHint, ...envelope } = error;
  const text = modelHint === undefined ? envelope.message : `${envelope.message} ${modelHint}`;
  return { content: [{ type: 'text', text }], structuredContent: envelope, isError: true };
}

function invalidInput(tool: ToolDefinition, issues: readonly z.core.$ZodIssue[]): ErrorEnvelope {
  const list = issues.slice(0, MAX_ISSUES).map((i) => ({
    path: clip(i.path.map(String).join('.'), 120),
    message: clip(i.message, 200),
  }));
  const summary = list.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ');
  return toolError('invalid_input', clip(`Invalid arguments for ${tool.name}: ${summary}`, 300), { details: { issues: list } });
}

export function createMcpHandler(config: ServerConfig, deps: HandlerDeps): McpHandler {
  const authenticate = bearerAuthenticator(config.clients);
  const allowedOrigins = new Set(config.allowedOrigins);

  const now = deps.now ?? (() => performance.now());

  function record(error: ErrorEnvelope, correlationId: string, ctx?: Partial<ToolContext>, details?: Record<string, unknown>) {
    if (!LOGGED.has(error.category)) return;
    const sandbox = ctx?.homeId !== undefined && isSandbox(ctx.homeId);
    const allDetails = { ...details, ...(sandbox ? { home: 'sandbox' } : {}) };
    deps.logger.log({
      ts: new Date().toISOString(),
      level: error.category === 'internal' ? 'error' : 'warn',
      component: 'mcp-server',
      code: error.code,
      category: error.category,
      message: error.message,
      correlationId,
      ...(ctx?.homeId === undefined || sandbox ? {} : { homeId: ctx.homeId }),
      ...(ctx?.clientId === undefined ? {} : { clientId: ctx.clientId }),
      ...(Object.keys(allDetails).length === 0 ? {} : { details: allDetails }),
    });
  }

  /** One info line and one latency metric per tools/call (G6, #146). */
  function observe(name: string, result: CallToolResult, durationMs: number, ctx: ToolContext): void {
    const outcome: ToolCallOutcome = result.isError === true ? 'error' : 'ok';
    const code = outcome === 'error' ? (result.structuredContent as { code?: unknown } | undefined)?.code : undefined;
    deps.logger.log({
      ts: new Date().toISOString(),
      level: 'info',
      component: 'mcp-server',
      message: `tools/call ${name}`,
      correlationId: ctx.correlationId,
      ...(isSandbox(ctx.homeId) ? {} : { homeId: ctx.homeId }),
      clientId: ctx.clientId,
      details: { tool: name, durationMs, outcome, ...(typeof code === 'string' ? { code } : {}), ...homeDetail(ctx.homeId) },
    });
    deps.metrics?.(toolCallMetric({ namespace: config.metricsNamespace, tool: name, outcome, durationMs, atMs: Date.now() }));
  }

  async function runTool(tool: ToolDefinition, args: unknown, ctx: ToolContext): Promise<CallToolResult> {
    const input = tool.input.safeParse(args ?? {});
    if (!input.success) return errorResult(invalidInput(tool, input.error.issues));

    let outcome;
    try {
      outcome = await tool.handler(input.data, ctx);
    } catch (e) {
      const error = toolError('unexpected_error', `The server hit an unexpected error. Quote correlation id ${ctx.correlationId} when reporting it.`);
      record(error, ctx.correlationId, ctx, { tool: tool.name, errorName: e instanceof Error ? e.name : typeof e });
      return errorResult(error);
    }
    if (!outcome.ok) {
      record(outcome.error, ctx.correlationId, ctx, { tool: tool.name });
      return errorResult(outcome.error);
    }

    const output = tool.output.safeParse(outcome.value);
    if (!output.success) {
      const error = toolError('output_schema_violation', `The server produced an invalid result for ${tool.name}.`);
      record(error, ctx.correlationId, ctx, { tool: tool.name, issues: output.error.issues.slice(0, MAX_ISSUES).map((i) => i.path.join('.')) });
      return errorResult(error);
    }
    const text = tool.summarize ? tool.summarize(output.data, ctx) : JSON.stringify(output.data);
    return { content: [{ type: 'text', text }], structuredContent: output.data as Record<string, unknown> };
  }

  function readResource(resource: UiResource, ctx: ToolContext): ReadResourceResult {
    let document;
    try {
      document = resource.read();
    } catch (e) {
      const error = toolError('unexpected_error', `The server hit an unexpected error. Quote correlation id ${ctx.correlationId} when reporting it.`);
      record(error, ctx.correlationId, ctx, { resource: resource.uri, errorName: e instanceof Error ? e.name : typeof e });
      throw new McpError(RpcErrorCode.InternalError, error.message);
    }
    if (!document.ok) {
      record(document.error, ctx.correlationId, ctx, { resource: resource.uri });
      throw new McpError(RpcErrorCode.InternalError, document.error.message);
    }
    // The document needs no network at all (plan §9.4): the host may deny every domain.
    return { contents: [{ uri: resource.uri, mimeType: CARD_MIME_TYPE, text: document.value, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }] };
  }

  // The low-level Server (not McpServer) is the decision of spike S1 (#5): structured input errors
  // and unknown tool -> JSON-RPC -32602 need our own tools/call handler.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
  function buildServer(ctx: ToolContext): Server {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
    const server = new Server({ name: config.serverName, version: config.serverVersion }, {
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
    });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: deps.registry.toolsFor(ctx.homeId).map(listTool) }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = deps.registry.findTool(request.params.name, ctx.homeId);
      if (!tool) throw new McpError(RpcErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
      const started = now();
      // Who asked for the proposal: the agent's _meta, never an argument the model writes (owner, 22 Oct).
      const asked = request.params._meta?.[ASKED_BY_PERSON_META] === true;
      const result = await runTool(tool, request.params.arguments, asked ? { ...ctx, askedByPerson: true } : ctx);
      observe(tool.name, result, Math.round(now() - started), ctx);
      return result;
    });
    server.setRequestHandler(ListResourcesRequestSchema, () => ({
      resources: deps.registry
        .resourcesFor(ctx.homeId)
        .map((r) => ({ uri: r.uri, name: r.name, title: r.title, description: r.description, mimeType: CARD_MIME_TYPE })),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, (request) => {
      const resource = deps.registry.findResource(request.params.uri, ctx.homeId);
      if (!resource) throw new McpError(RESOURCE_NOT_FOUND, `Resource not found: ${request.params.uri}`);
      return readResource(resource, ctx);
    });
    return server;
  }

  /** The 401 challenge; it names the metadata document when there is one (RFC 9728 §5.1). */
  function bearerChallenge(req: Request, error?: string): string {
    const metadata = config.protectedResource === undefined ? undefined : metadataUrl(resourceUrl(config.protectedResource, req, config.path), config.path);
    return ['Bearer realm="mcp"', ...(error === undefined ? [] : [`error="${error}"`]), ...(metadata === undefined ? [] : [`resource_metadata="${metadata}"`])].join(', ');
  }

  async function route(req: Request, correlationId: string): Promise<Response> {
    if (config.protectedResource !== undefined && new URL(req.url).pathname === PRM_PREFIX + config.path) {
      return protectedResourceMetadata(req, correlationId, config.protectedResource, config.path);
    }
    if (new URL(req.url).pathname !== config.path) {
      return problem(toolError('route_not_found', `The MCP endpoint is ${config.path}.`), correlationId, 404);
    }
    if (req.method !== 'POST') {
      return problem(toolError('method_not_allowed', 'This stateless MCP endpoint accepts POST only.'), correlationId, 405, { allow: 'POST' });
    }
    const origin = req.headers.get('origin');
    if (origin !== null && !allowedOrigins.has(origin)) {
      return problem(toolError('origin_not_allowed', 'The request Origin is not in the allowlist.'), correlationId);
    }

    const grant = authenticate(req.headers.get('authorization'));
    if (grant === undefined) {
      const error = toolError('missing_token', 'Send Authorization: Bearer <token>.');
      record(error, correlationId);
      return problem(error, correlationId, undefined, { 'www-authenticate': bearerChallenge(req) });
    }
    // A phone token opens the family inbox only, never a tool (#24).
    if (grant === null || grant.scope === 'phone') {
      const error = toolError('wrong_client', 'The token was not issued for this server.');
      record(error, correlationId);
      return problem(error, correlationId, undefined, { 'www-authenticate': bearerChallenge(req, 'invalid_token') });
    }

    const declared = Number(req.headers.get('content-length') ?? 0);
    const body = declared > config.maxBodyBytes ? '' : await req.text();
    if (declared > config.maxBodyBytes || Buffer.byteLength(body) > config.maxBodyBytes) {
      return problem(toolError('payload_too_large', `The request body is over ${config.maxBodyBytes} bytes.`), correlationId, 413);
    }

    if (config.requireProtocolVersionHeader && !req.headers.has('mcp-protocol-version') && !isInitialize(body)) {
      return problem(toolError('missing_protocol_version', 'Send the MCP-Protocol-Version header negotiated at initialization.'), correlationId);
    }

    // The home comes from the token; a demo#* grant may name a visitor sandbox instead (#101).
    // The real home is never reachable this way: only demo#<16 hex> passes, and only for that grant.
    let homeId = grant.homeId;
    const requested = req.headers.get(HOME_HEADER);
    if (requested !== null) {
      const sandbox = SandboxHomeIdSchema.safeParse(requested);
      if (grant.sandboxes !== true || !sandbox.success || deps.sandboxes === undefined) {
        const error = toolError('home_not_allowed', 'This client may not reach that home.');
        record(error, correlationId, { clientId: grant.clientId });
        return problem(error, correlationId);
      }
      const admitted = deps.sandboxes.admit(sandbox.data);
      if (!admitted.ok) {
        record(admitted.error, correlationId, { clientId: grant.clientId });
        return problem(admitted.error, correlationId);
      }
      // The visitor's saved settings (C2b): one read per request, so every container plays a change at once.
      // Only a tools/call acts: initialize, notifications and tools/list skip it, and with it the storm catch-up (#406).
      if (isToolCall(body)) await deps.sandboxes.refresh(sandbox.data, correlationId);
      homeId = sandbox.data;
    }

    // The turn of the conversation (#230): the agent names it, a card tap does not. A malformed one is refused.
    const turn = turnIdFrom(req.headers.get(TURN_HEADER));
    if (!turn.ok) {
      record(turn.error, correlationId, { clientId: grant.clientId });
      return problem(turn.error, correlationId);
    }
    // #233: the agent's tool calls always name their turn, so it never passes for the person's tap; a card action
    // (sim-api) never names one, so it never passes for a turn. Unscoped clients keep both ways (the accepted risk).
    const unnamed = grant.scope === 'agent' && turn.value === undefined && isToolCall(body);
    const named = grant.scope === 'cards' && turn.value !== undefined;
    if (unnamed || named) {
      const error = toolError('invalid_input', unnamed ? `The agent's tool calls name their turn in ${TURN_HEADER}.` : `A card action names no turn: send no ${TURN_HEADER}.`);
      // A refused client is a warning even though the input category is not logged: a token used the wrong way.
      deps.logger.log({
        ts: new Date().toISOString(),
        level: 'warn',
        component: 'mcp-server',
        code: error.code,
        category: error.category,
        message: error.message,
        correlationId,
        clientId: grant.clientId,
        details: { event: unnamed ? 'agent_call_without_turn' : 'card_action_with_turn' },
      });
      return problem(error, correlationId);
    }
    // #26: a read-scoped client (the classic Alexa skill) calls only the read tools of READ_SCOPE_TOOLS, batches included.
    if (grant.scope === 'read' && callsOutside(body, READ_SCOPE_TOOLS)) {
      const error = toolError('wrong_client', 'This client may call only the read tools.');
      deps.logger.log({
        ts: new Date().toISOString(),
        level: 'warn',
        component: 'mcp-server',
        code: error.code,
        category: error.category,
        message: error.message,
        correlationId,
        clientId: grant.clientId,
        details: { event: 'read_client_call_refused' },
      });
      return problem(error, correlationId);
    }
    const ctx: ToolContext = { correlationId, clientId: grant.clientId, homeId, ...(turn.value === undefined ? {} : { turnId: turn.value }) };
    const server = buildServer(ctx);
    // Stateless: no sessionIdGenerator (the documented `undefined` breaks exactOptionalPropertyTypes).
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(new Request(req.url, { method: 'POST', headers: req.headers, body }));
    } finally {
      await server.close();
    }
  }

  return async (req) => {
    const correlationId = correlationIdFrom(req.headers.get(CORRELATION_ID_HEADER), randomUUID);
    const res = await route(req, correlationId);
    const headers = new Headers(res.headers);
    headers.set(CORRELATION_ID_HEADER, correlationId);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

/**
 * A JSON-RPC tools/call: the only request that acts; initialize and tools/list name no turn. A batch counts as one if
 * any of its messages is (the SDK still accepts batches): it cannot carry a tool call past the turn rule (#245 review).
 */
function isToolCall(body: string): boolean {
  const isCall = (message: unknown) => typeof message === 'object' && message !== null && (message as { method?: unknown }).method === 'tools/call';
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) ? parsed.some(isCall) : isCall(parsed);
  } catch {
    // Not JSON: the transport refuses it anyway, before any tool runs.
    return false;
  }
}

/** Whether the body (one message or a batch) holds a tools/call for a tool outside `allowed`. Not JSON: no call. */
function callsOutside(body: string, allowed: ReadonlySet<string>): boolean {
  const outside = (message: unknown) => {
    if (typeof message !== 'object' || message === null || (message as { method?: unknown }).method !== 'tools/call') return false;
    const name = (message as { params?: { name?: unknown } }).params?.name;
    return typeof name !== 'string' || !allowed.has(name);
  };
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) ? parsed.some(outside) : outside(parsed);
  } catch {
    return false;
  }
}

/** Malformed JSON counts as "initialize": the transport then answers with a JSON-RPC parse error. */
function isInitialize(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && (parsed as { method?: unknown }).method === 'initialize';
  } catch {
    return true;
  }
}
