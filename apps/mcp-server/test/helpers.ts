import { HomeIdSchema, ok, type HomeId } from '@cold-reserve/contracts';
import { z } from 'zod';
import type { ServerConfig } from '../src/config.js';
import { createMcpHandler, type LogEntry } from '../src/handler.js';
import { createRegistry, type CapabilityModule } from '../src/registry.js';
import { defineTool } from '../src/tool.js';

export const TOKEN = 'a'.repeat(32);
export const HOME_TOKEN = 'h'.repeat(32);
export const OTHER_TOKEN = 'z'.repeat(32);
export const ALLOWED_ORIGIN = 'http://127.0.0.1:5173';
export const PROTOCOL_VERSION = '2025-11-25';
export const URL_MCP = 'http://127.0.0.1:3316/mcp';

export const homeId = (id: string): HomeId => HomeIdSchema.parse(id);

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    clients: new Map([
      [TOKEN, { clientId: 'agent', homeId: homeId('demo') }],
      [HOME_TOKEN, { clientId: 'video', homeId: homeId('home') }],
    ]),
    allowedOrigins: [ALLOWED_ORIGIN],
    requireProtocolVersionHeader: true,
    path: '/mcp',
    maxBodyBytes: 64 * 1024,
    serverName: 'cold-reserve-test',
    serverVersion: '0.0.0',
    ...overrides,
  };
}

/** Test-only module: a tool that echoes the context, one that throws, one whose output breaks its schema. */
export const probeModule: CapabilityModule = {
  id: 'probe',
  tools: [
    defineTool({
      name: 'whoami',
      title: 'Who am I',
      description: 'Test-only: returns the caller identity derived from the token.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      input: z.strictObject({ note: z.string().max(10).optional() }),
      output: z.strictObject({ clientId: z.string(), homeId: z.string() }),
      handler: (_args, ctx) => Promise.resolve(ok({ clientId: ctx.clientId, homeId: ctx.homeId })),
    }),
    defineTool({
      name: 'explode',
      title: 'Explode',
      description: 'Test-only tool that throws.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      input: z.strictObject({}),
      output: z.strictObject({ never: z.string() }),
      handler: () => Promise.reject(new Error('boom at /secret/path/file.ts:42')),
    }),
    defineTool({
      name: 'bad_output',
      title: 'Bad output',
      description: 'Test-only tool whose output breaks its own schema.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      input: z.strictObject({}),
      output: z.strictObject({ value: z.number() }),
      handler: () => Promise.resolve(ok(JSON.parse('{"value":"not a number"}') as { value: number })),
    }),
  ],
};

export function makeHandler(opts: { config?: Partial<ServerConfig>; modules?: CapabilityModule[] } = {}) {
  const logs: LogEntry[] = [];
  const registry = createRegistry(opts.modules ?? [probeModule]);
  if (!registry.ok) throw new Error(registry.error.message);
  const handler = createMcpHandler(testConfig(opts.config), { registry: registry.value, logger: { log: (e) => logs.push(e) } });
  return { handler, logs };
}

export function baseHeaders(extra: Record<string, string | undefined> = {}): Headers {
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TOKEN}`,
    'mcp-protocol-version': PROTOCOL_VERSION,
  });
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) headers.delete(key);
    else headers.set(key, value);
  }
  return headers;
}

export function post(
  handler: (req: Request) => Promise<Response>,
  body: unknown,
  extraHeaders: Record<string, string | undefined> = {},
  url = URL_MCP,
): Promise<Response> {
  return handler(
    new Request(url, { method: 'POST', headers: baseHeaders(extraHeaders), body: typeof body === 'string' ? body : JSON.stringify(body) }),
  );
}

export const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'unit-test', version: '0.0.0' } },
};

export const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

export function callTool(name: string, args?: unknown, id = 7) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, ...(args === undefined ? {} : { arguments: args }) } };
}

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

export async function toolResult(res: Response): Promise<ToolResult> {
  if (res.status !== 200) throw new Error(`HTTP ${String(res.status)}: ${await res.text()}`);
  const body = (await res.json()) as { result?: ToolResult; error?: { message: string } };
  if (!body.result) throw new Error(`JSON-RPC error: ${body.error?.message ?? 'none'}`);
  return body.result;
}
