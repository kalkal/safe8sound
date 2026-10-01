import { HOME_HEADER, StatusFactsSchema, ToolCardSchema, type HomeId, type StatusFacts, type ToolCard } from '@cold-reserve/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { FunctionTool } from '@strands-agents/sdk';
import type { AgentConfig, McpToken } from './config.js';

// Our own MCP wrapper (approved in #101): Strands' McpTool drops structuredContent, so each server
// tool becomes a Strands tool here. The model gets the text; the code keeps the card data.

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
}

export interface McpCallResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** The two MCP calls the wrapper needs: a real client, or a fake one in tests. */
export interface McpSession {
  listTools(): Promise<McpToolInfo[]>;
  /** `correlationId` is the user turn's id: sent as x-correlation-id with the request. */
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, correlationId?: string): Promise<McpCallResult>;
}

/** The tools whose results the simulator shows as cards (TurnReply.cards). */
const CARD_TOOLS: ReadonlySet<string> = new Set(['plan_comfort', 'apply_plan', 'get_reserve_outlook', 'get_preferences']);

/** What a turn produced besides the text: valid cards and the status facts of get_home_status. */
export function createTurnRecorder() {
  let cards: ToolCard[] = [];
  let status: StatusFacts | undefined;
  let turnId: string | undefined;
  return {
    record(tool: string, structured: Record<string, unknown> | undefined) {
      if (structured === undefined) return;
      if (CARD_TOOLS.has(tool) && cards.length < 4) {
        const card = ToolCardSchema.safeParse({ tool, result: structured });
        if (card.success) cards.push(card.data);
      }
      if (tool === 'get_home_status') {
        const facts = StatusFactsSchema.safeParse({ batterySocPct: structured['batterySocPct'], origin: structured['origin'], ts: structured['ts'] });
        if (facts.success) status = facts.data;
      }
    },
    cards: (): readonly ToolCard[] => [...cards],
    status: () => status,
    /** The correlation id of the current turn, for every MCP call it makes. */
    correlationId: () => turnId,
    reset(correlationId?: string) {
      cards = [];
      status = undefined;
      turnId = correlationId;
    },
  };
}
export type TurnRecorder = ReturnType<typeof createTurnRecorder>;

const textOf = (result: McpCallResult) => result.content.map((c) => c.text ?? '').join('\n');

export async function mcpToolset(session: McpSession, recorder: TurnRecorder): Promise<FunctionTool[]> {
  return (await session.listTools()).map(
    (info) =>
      new FunctionTool({
        name: info.name,
        description: info.description ?? info.name,
        inputSchema: info.inputSchema,
        callback: async (input, context) => {
          const args = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
          // The Strands loop passes its cancel signal (turn deadline); a direct invoke may not.
          const signal = (context as { cancelSignal?: AbortSignal } | undefined)?.cancelSignal;
          const result = await session.callTool(info.name, args, signal, recorder.correlationId());
          // A tool error reaches the model as an error result (with its text); it never becomes a card.
          if (result.isError === true) throw new Error(textOf(result));
          recorder.record(info.name, result.structuredContent);
          return textOf(result);
        },
      }),
  );
}

/**
 * Headers of every MCP request. The sandbox home comes from the invocation (set by sim-api from its
 * token), never from the model: tool arguments cannot reach this function.
 */
export function mcpRequestHeaders(token: McpToken, home: HomeId | undefined): Record<string, string> {
  return { authorization: `Bearer ${token.reveal()}`, ...(home === undefined ? {} : { [HOME_HEADER]: home }) };
}

/** Adds the turn's x-correlation-id to every MCP HTTP request (one session serves one home, one turn at a time). */
export function withCorrelationHeader(fetchFn: (url: string | URL, init?: RequestInit) => Promise<Response>, current: () => string | undefined) {
  return (url: string | URL, init?: RequestInit): Promise<Response> => {
    const id = current();
    if (id === undefined) return fetchFn(url, init);
    const headers = new Headers(init?.headers);
    headers.set('x-correlation-id', id);
    return fetchFn(url, { ...init, headers });
  };
}

/** A real MCP session over Streamable HTTP to config.mcpUrl. */
export async function connectMcp(config: Pick<AgentConfig, 'mcpUrl'>, token: McpToken, home: HomeId | undefined): Promise<McpSession & { close(): Promise<void> }> {
  const client = new Client({ name: 'cold-reserve-agent', version: '0.0.0' });
  let current: string | undefined;
  const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
    requestInit: { headers: mcpRequestHeaders(token, home) },
    fetch: withCorrelationHeader((url, init) => fetch(url, init), () => current),
  });
  // SDK v1 types do not satisfy exactOptionalPropertyTypes (sessionId?: string vs undefined).
  await client.connect(transport as unknown as Transport);
  return {
    listTools: async () => (await client.listTools()).tools as McpToolInfo[],
    callTool: async (name, args, signal, correlationId) => {
      current = correlationId;
      return (await client.callTool({ name, arguments: args }, undefined, signal ? { signal } : {})) as McpCallResult;
    },
    close: () => client.close(),
  };
}
