import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { ServerConfig } from './config.js';
import { listTool, type ToolContext, type ToolDefinition } from './tool.js';
import { toolError, type ErrorCategory, type ToolError } from './tool-error.js';

export interface LogEntry {
  ts: string;
  level: 'error' | 'warn';
  component: 'mcp-server';
  code: string;
  category: ErrorCategory;
  message: string;
  correlationId: string;
  clientId?: string;
  details?: Record<string, unknown>;
}

export interface Logger {
  log: (entry: LogEntry) => void;
}

export interface HandlerDeps {
  tools: ReadonlyArray<ToolDefinition<any, any>>;
  logger: Logger;
}

// Categories kept in the error log (docs/error-handling.md §6.1).
const LOGGED: ReadonlySet<ErrorCategory> = new Set(['internal', 'dependency_unavailable', 'guard_rejection', 'unauthorized']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256 = (value: string) => createHash('sha256').update(value).digest();

function problem(
  status: number,
  code: string,
  title: string,
  detail: string,
  correlationId: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ type: `urn:cold-reserve:error:${code}`, title, status, detail, instance: `urn:uuid:${correlationId}`, code }),
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );
}

function formatIssues(issues: readonly z.core.$ZodIssue[]) {
  return issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

function errorResult(error: ToolError): CallToolResult {
  return { content: [{ type: 'text', text: error.message }], structuredContent: error, isError: true };
}

export function createMcpHandler(config: ServerConfig, deps: HandlerDeps): (req: Request) => Promise<Response> {
  const tools = new Map(deps.tools.map((t) => [t.name, t]));
  const listed = deps.tools.map((t) => listTool(t));
  const tokenDigests = [...config.clientTokens].map(([token, clientId]) => ({ digest: sha256(token), clientId }));
  const allowedOrigins = new Set(config.allowedOrigins);

  function authenticate(header: string | null): string | undefined {
    const match = header?.match(/^Bearer ([^\s]+)$/);
    if (!match?.[1]) return undefined;
    const presented = sha256(match[1]);
    let clientId: string | undefined;
    // Compare against every token so timing does not reveal which one matched.
    for (const entry of tokenDigests) {
      if (timingSafeEqual(presented, entry.digest)) clientId = entry.clientId;
    }
    return clientId ?? '';
  }

  function record(error: ToolError, ctx: ToolContext, details?: Record<string, unknown>) {
    if (!LOGGED.has(error.category)) return;
    const extra = details ?? error.details;
    deps.logger.log({
      ts: new Date().toISOString(),
      level: error.category === 'internal' ? 'error' : 'warn',
      component: 'mcp-server',
      code: error.code,
      category: error.category,
      message: error.message,
      correlationId: ctx.correlationId,
      clientId: ctx.clientId,
      ...(extra !== undefined && { details: extra }),
    });
  }

  async function runTool(tool: ToolDefinition<any, any>, args: unknown, ctx: ToolContext): Promise<CallToolResult> {
    const input = tool.input.safeParse(args ?? {});
    if (!input.success) {
      const issues = formatIssues(input.error.issues);
      const summary = issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ');
      return errorResult(toolError('invalid_arguments', 'validation', `Invalid arguments for ${tool.name}: ${summary}`, { details: { issues } }));
    }

    let outcome;
    try {
      outcome = await tool.handler(input.data, ctx);
    } catch (e) {
      const error = toolError(
        'unexpected_error',
        'internal',
        `The server hit an unexpected error. Quote correlation id ${ctx.correlationId} when reporting it.`,
      );
      record(error, ctx, { tool: tool.name, errorName: e instanceof Error ? e.name : typeof e, errorMessage: String(e) });
      return errorResult(error);
    }

    if (!outcome.ok) {
      record(outcome.error, ctx);
      return errorResult(outcome.error);
    }

    const output = tool.output.safeParse(outcome.value);
    if (!output.success) {
      const error = toolError('output_schema_violation', 'internal', `The server produced an invalid result for ${tool.name}.`);
      record(error, ctx, { tool: tool.name, issues: formatIssues(output.error.issues) });
      return errorResult(error);
    }
    const text = tool.summarize ? tool.summarize(output.data) : JSON.stringify(output.data);
    return { content: [{ type: 'text', text }], structuredContent: output.data };
  }

  function buildServer(ctx: ToolContext): Server {
    const server = new Server(
      { name: config.serverName, version: config.serverVersion },
      { capabilities: { tools: { listChanged: false } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = tools.get(request.params.name);
      if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
      return runTool(tool, request.params.arguments, ctx);
    });
    return server;
  }

  async function route(req: Request, correlationId: string): Promise<Response> {
    if (req.method !== 'POST') {
      return problem(405, 'method_not_allowed', 'Method not allowed', 'This stateless MCP endpoint accepts POST only.', correlationId, {
        allow: 'POST',
      });
    }

    const origin = req.headers.get('origin');
    if (origin !== null && !allowedOrigins.has(origin)) {
      return problem(403, 'origin_not_allowed', 'Origin not allowed', 'The request Origin is not in the allowlist.', correlationId);
    }

    const clientId = authenticate(req.headers.get('authorization'));
    if (clientId === undefined) {
      return problem(401, 'missing_token', 'Missing bearer token', 'Send Authorization: Bearer <token>.', correlationId, {
        'www-authenticate': 'Bearer realm="mcp"',
      });
    }
    if (clientId === '') {
      return problem(401, 'invalid_token', 'Invalid bearer token', 'The token was not issued for this server.', correlationId, {
        'www-authenticate': 'Bearer realm="mcp", error="invalid_token"',
      });
    }

    const body = await req.text();
    if (config.requireProtocolVersionHeader && !req.headers.has('mcp-protocol-version')) {
      let isInitialize = false;
      try {
        const parsed: unknown = JSON.parse(body);
        isInitialize = typeof parsed === 'object' && parsed !== null && (parsed as { method?: unknown }).method === 'initialize';
      } catch {
        // Malformed JSON: the transport answers with a JSON-RPC parse error below.
        isInitialize = true;
      }
      if (!isInitialize) {
        return problem(
          400,
          'missing_protocol_version',
          'Missing MCP-Protocol-Version',
          'Send the MCP-Protocol-Version header negotiated at initialization.',
          correlationId,
        );
      }
    }

    const ctx: ToolContext = { correlationId, clientId };
    const server = buildServer(ctx);
    // No sessionIdGenerator means stateless mode (the documented `sessionIdGenerator: undefined`
    // does not compile under exactOptionalPropertyTypes).
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(new Request(req.url, { method: 'POST', headers: req.headers, body }), {
        authInfo: { token: 'redacted', clientId, scopes: [] },
      });
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
