import { HOME_HEADER, ToolCallReplySchema, err, ok, toolError, type ErrorEnvelope, type HomeId, type Result, type ToolCallReply } from '@cold-reserve/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
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

/** The real MCP caller: one stateless Streamable HTTP request per call, with the sandbox header. */
export function streamableMcpCaller(opts: { url: string; token: string }): McpCaller {
  return async (home, name, args, signal, correlationId) => {
    const client = new Client({ name: 'cold-reserve-sim-api', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
      requestInit: { headers: { authorization: `Bearer ${opts.token}`, [HOME_HEADER]: home, 'x-correlation-id': correlationId } },
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
