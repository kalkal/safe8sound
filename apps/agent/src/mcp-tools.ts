import { ASKED_BY_PERSON_META, CORRELATION_ID_HEADER, MODEL_HIDDEN_TOOLS, CorrelationIdSchema, GuardRefusalSchema, TURN_HEADER, HOME_HEADER, StatusFactsSchema, ToolCardSchema, toolError, type HomeId, type StatusFacts, type ToolCard } from '@cold-reserve/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { FunctionTool } from '@strands-agents/sdk';
import type { AgentConfig, McpToken } from './config.js';
import { askedByPerson } from './asked-by-person.js';
import { logLine, type AgentLogEntry } from './log.js';

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
  /** `meta`: the call's `_meta`, set by the code, never by the model (ASKED_BY_PERSON_META on plan_comfort). */
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, correlationId?: string, meta?: Record<string, unknown>): Promise<McpCallResult>;
  /** Ends the session (the real client); a fake may omit it. */
  close?(): Promise<void>;
}

/** The tools whose results the simulator shows as cards (TurnReply.cards). */
// get_home_status is not a card here yet: a floor plan on every battery answer would clutter the screen (#171).
const CARD_TOOLS: ReadonlySet<string> = new Set(['plan_comfort', 'apply_plan', 'get_reserve_outlook', 'get_preferences', 'get_safe_room_status']);

const isRefusal = (c: ToolCard) => c.tool === 'plan_comfort' && GuardRefusalSchema.safeParse(c.result).success;

/** What a turn produced besides the text: valid cards and the status facts of get_home_status. */
export function createTurnRecorder() {
  let cards: ToolCard[] = [];
  let status: StatusFacts | undefined;
  let turnId: string | undefined;
  let question: string | undefined;
  return {
    record(tool: string, structured: Record<string, unknown> | undefined) {
      if (structured === undefined) return;
      if (CARD_TOOLS.has(tool)) {
        const card = ToolCardSchema.safeParse({ tool, result: structured });
        // At most one refusal card per answer, the last (#202): earlier refusals of the turn are replaced.
        if (card.success && isRefusal(card.data)) cards = cards.filter((c) => !isRefusal(c));
        if (card.success && cards.length < 4) cards.push(card.data);
      }
      if (tool === 'get_home_status') {
        const facts = StatusFactsSchema.safeParse({ batterySocPct: structured['batterySocPct'], origin: structured['origin'], ts: structured['ts'] });
        if (facts.success) status = facts.data;
      }
    },
    cards: (): readonly ToolCard[] => [...cards],
    status: () => status,
    /** The person's words of the current turn: only the code reads them, to tell who asked for a proposal (22 Oct). */
    question: () => question,
    /** The correlation id of the current turn, for every MCP call it makes. */
    correlationId: () => turnId,
    reset(correlationId?: string, asked?: string) {
      cards = [];
      status = undefined;
      turnId = correlationId;
      question = asked;
    },
  };
}
export type TurnRecorder = ReturnType<typeof createTurnRecorder>;

const textOf = (result: McpCallResult) => result.content.map((c) => c.text ?? '').join('\n');

/**
 * Arguments only the host may carry (#201): the last-resort token comes from the card's second tap. The model
 * never sees them in a schema and never passes them, so it cannot ask the person for one or make one up.
 */
const HOST_ONLY_ARGS: Readonly<Record<string, readonly string[]>> = { apply_plan: ['lastResortToken'], plan_comfort: ['askedByPerson'] };

/** The tool's input schema without the host-only arguments. */
function modelSchema(name: string, schema: McpToolInfo['inputSchema']): McpToolInfo['inputSchema'] {
  const hidden = HOST_ONLY_ARGS[name];
  if (hidden === undefined) return schema;
  const all = typeof schema['properties'] === 'object' && schema['properties'] !== null ? (schema['properties'] as Record<string, unknown>) : {};
  const properties = Object.fromEntries(Object.entries(all).filter(([key]) => !hidden.includes(key)));
  const required = Array.isArray(schema['required']) ? (schema['required'] as unknown[]).filter((key) => typeof key === 'string' && !hidden.includes(key)) : undefined;
  return { ...schema, properties, ...(required === undefined ? {} : { required }) };
}

/** The model's arguments without any host-only one it passed anyway. */
function modelArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const hidden = HOST_ONLY_ARGS[name];
  return hidden === undefined ? args : Object.fromEntries(Object.entries(args).filter(([key]) => !hidden.includes(key)));
}

/**
 * The model's tools, over our own MCP session. Every call names its turn (#230): outside a well-formed turn the tool
 * is not called at all, the model gets an error and one warn line is logged (#233), so the agent never passes for
 * the person's tap on a card. The demo controls (the clock and the scenario) are never offered: only buttons use them.
 */
export async function mcpToolset(session: McpSession, recorder: TurnRecorder, log?: (line: AgentLogEntry) => void): Promise<FunctionTool[]> {
  const hidden: ReadonlySet<string> = new Set(MODEL_HIDDEN_TOOLS);
  return (await session.listTools()).filter((info) => !hidden.has(info.name)).map(
    (info) =>
      new FunctionTool({
        name: info.name,
        description: info.description ?? info.name,
        inputSchema: modelSchema(info.name, info.inputSchema),
        callback: async (input, context) => {
          const args = modelArgs(info.name, typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {});
          // The Strands loop passes its cancel signal (turn deadline); a direct invoke may not.
          const signal = (context as { cancelSignal?: AbortSignal } | undefined)?.cancelSignal;
          const turn = CorrelationIdSchema.safeParse(recorder.correlationId());
          if (!turn.success) {
            const error = toolError('invalid_input', `The tool ${info.name} was not called: this turn has no valid turn id.`);
            log?.(logLine(error, 'TurnIdInvalid'));
            throw new Error(error.message);
          }
          // Who asked for the proposal (owner, 22 Oct): decided here from the person's words, sent in _meta, never an argument.
          const meta = info.name === 'plan_comfort' ? { [ASKED_BY_PERSON_META]: askedByPerson(recorder.question(), args) } : undefined;
          const result = await session.callTool(info.name, args, signal, turn.data, meta);
          // A tool error reaches the model as an error result (with its text). Only a guard refusal with its
          // verdict also becomes a card, the REJECTED receipt (#186); every other error stays text.
          if (result.isError === true) {
            if (info.name === 'plan_comfort' && GuardRefusalSchema.safeParse(result.structuredContent).success) recorder.record(info.name, result.structuredContent);
            throw new Error(textOf(result));
          }
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
    headers.set(CORRELATION_ID_HEADER, id);
    // Every MCP call of the agent belongs to a model turn (#230): the server refuses apply_plan in the turn that
    // proposed the plan. Only a well-formed id is a turn id (a malformed header would fail the whole call).
    if (CorrelationIdSchema.safeParse(id).success) headers.set(TURN_HEADER, id);
    return fetchFn(url, { ...init, headers });
  };
}

/** A real MCP session over Streamable HTTP to config.mcpUrl. */
export async function connectMcp(config: Pick<AgentConfig, 'mcpUrl'>, token: McpToken, home: HomeId | undefined): Promise<McpSession> {
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
    callTool: async (name, args, signal, correlationId, meta) => {
      current = correlationId;
      return (await client.callTool({ name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) }, undefined, signal ? { signal } : {})) as McpCallResult;
    },
    close: () => client.close(),
  };
}
