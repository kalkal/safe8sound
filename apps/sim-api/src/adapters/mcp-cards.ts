import { HOME_HEADER, ToolCallReplySchema, err, ok, toolError, type ErrorEnvelope, type HomeId, type Result, type ToolCallReply } from '@cold-reserve/contracts';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { CardToolPort } from '../handler.js';

/** One MCP tools/call for a home: the real client below, a fake one in tests. */
export type McpCaller = (home: HomeId, name: string, args: Record<string, unknown>, signal: AbortSignal, correlationId: string) => Promise<unknown>;

/**
 * Card actions to the MCP server (#101). sim-api holds its own MCP token (a demo#* grant): the browser
 * never sees it, and the sandbox home comes from the demo token, never from the request body.
 */
export function mcpCardTools(opts: { caller: McpCaller; timeoutMs: number }): CardToolPort {
  return {
    async call({ home, request, correlationId }): Promise<Result<ToolCallReply, ErrorEnvelope>> {
      const timeout = AbortSignal.timeout(opts.timeoutMs);
      let raw: unknown;
      try {
        raw = await Promise.race([
          opts.caller(home, request.name, request.arguments, timeout, correlationId),
          new Promise<never>((_resolve, reject) => {
            timeout.addEventListener('abort', () => {
              reject(timeout.reason as Error);
            });
          }),
        ]);
      } catch {
        return timeout.aborted ? err(toolError('agent_timeout', 'The home did not answer in time.')) : err(toolError('agent_unavailable', 'The home could not be reached.'));
      }
      // Tool errors stay values for the card (isError + the envelope); only the CallToolResult fields pass.
      const reply = ToolCallReplySchema.safeParse(pick(raw));
      return reply.success ? ok(reply.data) : err(toolError('output_schema_violation', 'The home sent an unexpected result.'));
    },
  };
}

function pick(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const r = raw as { isError?: unknown; content?: unknown; structuredContent?: unknown };
  const content = Array.isArray(r.content) ? r.content.filter((c: { type?: unknown }) => c.type === 'text').map((c: { text?: unknown }) => ({ type: 'text', text: c.text })) : r.content;
  return { ...(r.isError === undefined ? {} : { isError: r.isError }), content, ...(r.structuredContent === undefined ? {} : { structuredContent: r.structuredContent }) };
}

/**
 * The real MCP caller (#406): ONE stateless Streamable HTTP POST per call, the JSON-RPC `tools/call` itself, with the
 * sandbox header and the negotiated protocol version. The server keeps no session (and a sandbox refresh runs on
 * tools/call only), so the initialize + initialized handshake of an SDK client would be two wasted round trips.
 * Any failure (transport, HTTP status, JSON-RPC error) throws: `mcpCardTools` turns it into a value.
 */
export function streamableMcpCaller(opts: { url: string; token: string; fetch?: typeof fetch }): McpCaller {
  const send = opts.fetch ?? fetch;
  return async (home, name, args, signal, correlationId) => {
    const res = await send(opts.url, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${opts.token}`,
        [HOME_HEADER]: home,
        'x-correlation-id': correlationId,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    if (!res.ok) throw new Error(`MCP server answered ${res.status}`);
    const message = (await res.json()) as { result?: unknown; error?: { message?: unknown } };
    if (message.error !== undefined) throw new Error(`MCP error: ${typeof message.error.message === 'string' ? message.error.message : 'unknown'}`);
    return message.result;
  };
}
