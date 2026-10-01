import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  HomeIdSchema,
  PROBLEM_JSON_CONTENT_TYPE,
  toProblemDetails,
  toolError,
  type ErrorCategory,
  type ErrorCode,
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
import type { ClientGrant, ServerConfig } from './config.js';
import type { ModuleRegistry, UiResource } from './registry.js';
import { SANDBOX_HOME, type Sandboxes } from './sandboxes.js';
import { listTool, type ToolContext, type ToolDefinition } from './tool.js';

/** One line of the error log (docs/error-handling.md §6.1): no secrets, no personal data. */
export interface LogEntry {
  ts: string;
  level: 'error' | 'warn';
  component: 'mcp-server';
  code: ErrorCode;
  category: ErrorCategory;
  message: string;
  correlationId: string;
  homeId?: string;
  clientId?: string;
  details?: Record<string, unknown>;
}

export interface Logger {
  log(entry: LogEntry): void;
}

export interface HandlerDeps {
  readonly registry: ModuleRegistry;
  readonly logger: Logger;
  /** Visitor sandboxes (#101): without it, no request can name a home. */
  readonly sandboxes?: Sandboxes<unknown>;
}

export type McpHandler = (req: Request) => Promise<Response>;

// Categories kept in the error log (docs/error-handling.md §6.1).
const LOGGED: ReadonlySet<ErrorCategory> = new Set(['internal', 'dependency_unavailable', 'guard_rejection', 'unauthorized']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ISSUES = 20;
/** MCP "resource not found" (spec 2025-11-25, server/resources); the SDK has no name for it. */
const RESOURCE_NOT_FOUND = -32002;
/** MCP Apps mime type of a ui:// document. */
export const CARD_MIME_TYPE = 'text/html;profile=mcp-app';

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function problem(error: ErrorEnvelope, correlationId: string, status?: HttpErrorStatus, headers: Record<string, string> = {}): Response {
  const body = toProblemDetails(error, { instance: `urn:uuid:${correlationId}`, ...(status === undefined ? {} : { status }) });
  return new Response(JSON.stringify(body), { status: body.status, headers: { 'content-type': PROBLEM_JSON_CONTENT_TYPE, ...headers } });
}

function errorResult(error: ErrorEnvelope): CallToolResult {
  return { content: [{ type: 'text', text: error.message }], structuredContent: error, isError: true };
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
  const tokens = [...config.clients].map(([token, grant]) => ({ digest: sha256(token), grant }));
  const allowedOrigins = new Set(config.allowedOrigins);

  /** undefined = no bearer token; null = a token nobody was issued. */
  function authenticate(header: string | null): ClientGrant | null | undefined {
    const match = header?.match(/^Bearer (\S+)$/);
    if (!match?.[1]) return undefined;
    const presented = sha256(match[1]);
    let grant: ClientGrant | null = null;
    // Compare against every token so timing does not reveal which one matched.
    for (const entry of tokens) if (timingSafeEqual(presented, entry.digest)) grant = entry.grant;
    return grant;
  }

  function record(error: ErrorEnvelope, correlationId: string, ctx?: Partial<ToolContext>, details?: Record<string, unknown>) {
    if (!LOGGED.has(error.category)) return;
    deps.logger.log({
      ts: new Date().toISOString(),
      level: error.category === 'internal' ? 'error' : 'warn',
      component: 'mcp-server',
      code: error.code,
      category: error.category,
      message: error.message,
      correlationId,
      ...(ctx?.homeId === undefined ? {} : { homeId: ctx.homeId }),
      ...(ctx?.clientId === undefined ? {} : { clientId: ctx.clientId }),
      ...(details === undefined ? {} : { details }),
    });
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
    const text = tool.summarize ? tool.summarize(output.data) : JSON.stringify(output.data);
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
      return runTool(tool, request.params.arguments, ctx);
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

  async function route(req: Request, correlationId: string): Promise<Response> {
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
      return problem(error, correlationId, undefined, { 'www-authenticate': 'Bearer realm="mcp"' });
    }
    if (grant === null) {
      const error = toolError('wrong_client', 'The token was not issued for this server.');
      record(error, correlationId);
      return problem(error, correlationId, undefined, { 'www-authenticate': 'Bearer realm="mcp", error="invalid_token"' });
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
    const requested = req.headers.get('x-cold-reserve-home');
    if (requested !== null) {
      if (grant.sandboxes !== true || !SANDBOX_HOME.test(requested) || deps.sandboxes === undefined) {
        const error = toolError('home_not_allowed', 'This client may not reach that home.');
        record(error, correlationId);
        return problem(error, correlationId);
      }
      const sandbox = HomeIdSchema.parse(requested);
      const admitted = deps.sandboxes.admit(sandbox);
      if (!admitted.ok) return problem(admitted.error, correlationId);
      homeId = sandbox;
    }

    const ctx: ToolContext = { correlationId, clientId: grant.clientId, homeId };
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
    const presented = req.headers.get('x-correlation-id');
    const correlationId = presented && UUID.test(presented) ? presented : randomUUID();
    const res = await route(req, correlationId);
    const headers = new Headers(res.headers);
    headers.set('x-correlation-id', correlationId);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
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
