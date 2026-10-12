import {
  CORRELATION_ID_HEADER,
  ErrorEnvelopeSchema,
  HomeStatusSchema,
  ReserveOutlookSchema,
  SafeRoomStatusSchema,
  ToolCallReplySchema,
  err,
  ok,
  toolError,
  type ErrorEnvelope,
  type HomeStatus,
  type ReserveOutlook,
  type Result,
  type SafeRoomStatus,
} from '@cold-reserve/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

// The MCP side of the skill, mirroring apps/sim-api/src/adapters/mcp-cards.ts (apps never import each other):
// one stateless Streamable HTTP request per call, an explicit timeout, and every outcome a value.

/** The three read-only tools the skill may call, with the schema of their structuredContent. */
export const SKILL_TOOLS = {
  get_home_status: HomeStatusSchema,
  get_reserve_outlook: ReserveOutlookSchema,
  get_safe_room_status: SafeRoomStatusSchema,
} as const;
export type SkillTool = keyof typeof SKILL_TOOLS;
export interface SkillToolOutput {
  get_home_status: HomeStatus;
  get_reserve_outlook: ReserveOutlook;
  get_safe_room_status: SafeRoomStatus;
}

/** One MCP tools/call with the skill's token: the real client below, a fake one in tests. */
export type McpCaller = (name: SkillTool, args: Record<string, unknown>, opts: { token: string; signal: AbortSignal; correlationId: string }) => Promise<unknown>;

/** A failed call: the envelope for the voice and the log, and the cause's name (never its text) for the log. */
export interface CallFailure {
  readonly error: ErrorEnvelope;
  /** Where it failed: the call itself, or the tool answering isError. */
  readonly source: 'call' | 'tool';
  readonly errorName?: string;
}

const nameOf = (e: unknown): string => (e instanceof Error ? e.name : typeof e).slice(0, 80);
/** The SDK's StreamableHTTPError carries the HTTP status in `code`. */
const statusOf = (e: unknown): unknown => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined);

/**
 * Calls one tool and checks the answer: the CallToolResult shape, then the tool's own output schema. A tool error
 * (isError + the error envelope) is passed on as the server's envelope; anything unreadable is output_schema_violation.
 */
export async function callSkillTool<T extends SkillTool>(
  caller: McpCaller,
  name: T,
  opts: { token: string; signal: AbortSignal; correlationId: string },
): Promise<Result<SkillToolOutput[T], CallFailure>> {
  const { signal } = opts;
  let raw: unknown;
  try {
    raw = await Promise.race([
      caller(name, {}, opts),
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason as Error);
        signal.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      }),
    ]);
  } catch (e) {
    if (signal.aborted) return err({ error: toolError('agent_timeout', 'The MCP server did not answer in time.'), source: 'call', errorName: nameOf(e) });
    const status = statusOf(e);
    if (status === 401 || status === 403) return err({ error: toolError('wrong_client', `The MCP server refused the skill's token (HTTP ${String(status)}).`), source: 'call', errorName: nameOf(e) });
    return err({ error: toolError('agent_unavailable', 'The MCP server could not be reached.'), source: 'call', errorName: nameOf(e) });
  }
  const reply = ToolCallReplySchema.safeParse(pick(raw));
  if (!reply.success) return err({ error: toolError('output_schema_violation', `${name} sent no valid CallToolResult.`), source: 'call' });
  if (reply.data.isError === true) {
    const envelope = ErrorEnvelopeSchema.safeParse(reply.data.structuredContent);
    return err(envelope.success ? { error: envelope.data, source: 'tool' } : { error: toolError('output_schema_violation', `${name} sent an error without a valid envelope.`), source: 'tool' });
  }
  const output = SKILL_TOOLS[name].safeParse(reply.data.structuredContent);
  // The schemas are a union by tool name: the parse above is the check, the cast only names the type.
  return output.success ? ok(output.data as SkillToolOutput[T]) : err({ error: toolError('output_schema_violation', `${name} sent structuredContent outside its output schema.`), source: 'call' });
}

/** Only the CallToolResult fields pass: text content and structuredContent. */
function pick(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const r = raw as { isError?: unknown; content?: unknown; structuredContent?: unknown };
  const content = Array.isArray(r.content) ? r.content.filter((c: { type?: unknown }) => c.type === 'text').map((c: { text?: unknown }) => ({ type: 'text', text: c.text })) : r.content;
  return { ...(r.isError === undefined ? {} : { isError: r.isError }), content, ...(r.structuredContent === undefined ? {} : { structuredContent: r.structuredContent }) };
}

/**
 * The real MCP caller: one stateless Streamable HTTP request per call. The token's home is `demo` (`read:alexa@demo`),
 * so no sandbox header is sent: the server binds the home to the token.
 */
export function streamableMcpCaller(opts: { url: string }): McpCaller {
  return async (name, args, { token, signal, correlationId }) => {
    const client = new Client({ name: 'cold-reserve-alexa-skill', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
      requestInit: { headers: { authorization: `Bearer ${token}`, [CORRELATION_ID_HEADER]: correlationId } },
    });
    // SDK v1 types do not satisfy exactOptionalPropertyTypes (sessionId?: string vs undefined).
    await client.connect(transport as unknown as Transport, { signal });
    try {
      return await client.callTool({ name, arguments: args }, undefined, { signal });
    } finally {
      await client.close();
    }
  };
}
