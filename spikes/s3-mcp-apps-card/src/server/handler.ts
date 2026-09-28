import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CARD_MIME_TYPE, PLAN_CARD_URI, renderCardHtml, type CardAssets } from './card-resource.js';
import { PlanInputSchema, PlanOutputSchema, planComfort } from './plan-tool.js';
import { toolError, ToolErrorSchema, type ErrorCategory, type ToolError } from './tool-error.js';

export interface LogEntry {
  ts: string;
  level: 'error' | 'warn';
  component: 'mcp-server';
  code: string;
  category: ErrorCategory;
  message: string;
  correlationId: string;
  details?: Record<string, unknown>;
}

export interface CardServerDeps {
  loadAssets: () => Promise<CardAssets>;
  logger: { log: (entry: LogEntry) => void };
}

// JSON-RPC code for "resource not found" in the MCP spec (resources, error handling).
const RESOURCE_NOT_FOUND = -32002;
const LOGGED: ReadonlySet<ErrorCategory> = new Set(['internal', 'dependency_unavailable', 'guard_rejection', 'unauthorized']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonSchema(schema: z.ZodType, io: 'input' | 'output') {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: 'throw' }) as Record<string, unknown>;
  return rest;
}

const PLAN_TOOL = {
  name: 'plan_comfort',
  description: 'Plans comfort until sunrise within the storm reserve and shows it as a card.',
  inputSchema: { ...jsonSchema(PlanInputSchema, 'input'), type: 'object' as const },
  // anyOf [success, error envelope]: the SDK client validates structuredContent even when isError is true (S1).
  outputSchema: { type: 'object' as const, ...jsonSchema(z.union([PlanOutputSchema, ToolErrorSchema]), 'output') },
  // Both keys: `ui.resourceUri` is current, `ui/resourceUri` keeps older hosts working (ext-apps registerAppTool does the same).
  _meta: { ui: { resourceUri: PLAN_CARD_URI }, 'ui/resourceUri': PLAN_CARD_URI },
};

const PLAN_CARD_RESOURCE = {
  uri: PLAN_CARD_URI,
  name: 'plan-card',
  title: 'Comfort plan card',
  mimeType: CARD_MIME_TYPE,
};

// The card needs no network: every domain list stays empty and the host builds a CSP of 'none'.
const PLAN_CARD_UI_META = { csp: { connectDomains: [] as string[], resourceDomains: [] as string[] }, prefersBorder: false };

export function createCardServer(deps: CardServerDeps): (req: Request) => Promise<Response> {
  function record(error: ToolError, correlationId: string, details?: Record<string, unknown>) {
    if (!LOGGED.has(error.category)) return;
    const extra = details ?? error.details;
    deps.logger.log({
      ts: new Date().toISOString(),
      level: error.category === 'internal' ? 'error' : 'warn',
      component: 'mcp-server',
      code: error.code,
      category: error.category,
      message: error.message,
      correlationId,
      ...(extra !== undefined && { details: extra }),
    });
  }

  const errorResult = (error: ToolError): CallToolResult => ({
    content: [{ type: 'text', text: error.message }],
    structuredContent: error,
    isError: true,
  });

  async function callPlan(args: unknown, correlationId: string): Promise<CallToolResult> {
    const input = PlanInputSchema.safeParse(args ?? {});
    if (!input.success) {
      const summary = input.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return errorResult(toolError('invalid_arguments', 'validation', `Invalid arguments for plan_comfort: ${summary}`));
    }
    const outcome = await planComfort(input.data);
    if (!outcome.ok) {
      record(outcome.error, correlationId);
      return errorResult(outcome.error);
    }
    const plan = PlanOutputSchema.parse(outcome.value);
    return {
      content: [{ type: 'text', text: `Comfortable at least until ${plan.until} (estimate, ${plan.confidence} confidence).` }],
      structuredContent: plan,
    };
  }

  function buildServer(correlationId: string): Server {
    const server = new Server({ name: 'cold-reserve-s3', version: '0.0.0' }, { capabilities: { tools: {}, resources: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [PLAN_TOOL] }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== PLAN_TOOL.name) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
      return callPlan(request.params.arguments, correlationId);
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ ...PLAN_CARD_RESOURCE, _meta: { ui: PLAN_CARD_UI_META } }] }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (request.params.uri !== PLAN_CARD_URI) {
        throw new McpError(RESOURCE_NOT_FOUND as ErrorCode, `Resource not found: ${request.params.uri}`);
      }
      let assets: CardAssets;
      try {
        assets = await deps.loadAssets();
      } catch (e) {
        const error = toolError('card_assets_unavailable', 'internal', 'The card could not be loaded.');
        record(error, correlationId, { reason: e instanceof Error ? e.message : String(e) });
        throw new McpError(ErrorCode.InternalError, `${error.message} Correlation id ${correlationId}.`);
      }
      return {
        contents: [{ uri: PLAN_CARD_URI, mimeType: CARD_MIME_TYPE, text: renderCardHtml(assets), _meta: { ui: PLAN_CARD_UI_META } }],
      };
    });
    return server;
  }

  return async (req) => {
    const presented = req.headers.get('x-correlation-id');
    const correlationId = presented && UUID.test(presented) ? presented : randomUUID();
    const server = buildServer(correlationId);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      const res = await transport.handleRequest(req);
      const headers = new Headers(res.headers);
      headers.set('x-correlation-id', correlationId);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    } finally {
      await server.close();
    }
  };
}
