import { z } from 'zod';
import type { ServerConfig } from '../src/config.js';
import { createMcpHandler, type LogEntry } from '../src/handler.js';
import { ok } from '../src/result.js';
import { defineTool } from '../src/tool.js';
import { reserveStatusTool, type HomeSnapshot } from '../src/tools/reserve-status.js';

export const TOKEN = 'a'.repeat(32);
export const OTHER_TOKEN = 'z'.repeat(32);
export const ALLOWED_ORIGIN = 'http://127.0.0.1:5173';
export const PROTOCOL_VERSION = '2025-11-25';
export const NOW = Date.UTC(2026, 8, 25, 21, 0, 0);

export const snapshots: Record<string, HomeSnapshot> = {
  'home-demo': { stateOfChargePct: 62, reserveHours: 9.5, observedAt: NOW - 60_000 },
  'home-stale': { stateOfChargePct: 40, reserveHours: 5, observedAt: NOW - 20 * 60_000 },
};

const explodeTool = defineTool({
  name: 'explode',
  description: 'Test-only tool that throws.',
  input: z.object({}),
  output: z.object({ never: z.string() }),
  handler: async () => {
    throw new Error('boom at /secret/path/file.ts:42');
  },
});

const badOutputTool = defineTool({
  name: 'bad_output',
  description: 'Test-only tool whose output breaks its own schema.',
  input: z.object({}),
  output: z.object({ value: z.number() }),
  handler: async () => ok({ value: 'not a number' } as unknown as { value: number }),
});

export function makeHandler(overrides: Partial<ServerConfig> = {}) {
  const logs: LogEntry[] = [];
  const config: ServerConfig = {
    clientTokens: new Map([[TOKEN, 'agent']]),
    allowedOrigins: [ALLOWED_ORIGIN],
    requireProtocolVersionHeader: true,
    serverName: 'cold-reserve-spike',
    serverVersion: '0.0.0',
    ...overrides,
  };
  const handler = createMcpHandler(config, {
    tools: [
      reserveStatusTool({ getSnapshot: (id) => snapshots[id], now: () => NOW, staleAfterMs: 15 * 60_000 }),
      explodeTool,
      badOutputTool,
    ],
    logger: { log: (entry) => logs.push(entry) },
  });
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
): Promise<Response> {
  return handler(
    new Request('http://127.0.0.1:3000/mcp', {
      method: 'POST',
      headers: baseHeaders(extraHeaders),
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

export const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'unit-test', version: '0.0.0' },
  },
};

export function callTool(name: string, args: unknown, id = 7) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}
