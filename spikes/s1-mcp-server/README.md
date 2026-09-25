# Spike S1: stateless MCP server over Streamable HTTP

Throwaway code for issue #5. Standalone package (own `pnpm-workspace.yaml` and lockfile), deliberately **outside** the repo workspace. The verdict lives as a comment on the issue; F3 (`apps/mcp-server`) takes the patterns, not the code.

## What it proves
- `@modelcontextprotocol/sdk` **1.30.1** (pinned), `WebStandardStreamableHTTPServerTransport` (Web `Request` → `Response`, no Express), stateless (no `sessionIdGenerator`), JSON responses, spec **2025-11-25**.
- One `Server` + transport per request, low-level `setRequestHandler` for `tools/list` and `tools/call`; Zod **v4 only** (4.6.5, a single copy in the lockfile), JSON Schema via native `z.toJSONSchema`.
- HTTP layer in front of the transport: POST only (GET/DELETE → 405 + `Allow: POST`), Origin allowlist (403, checked first), one bearer token per client (401 + `WWW-Authenticate`, constant-time compare), strict `MCP-Protocol-Version` (400 when missing on non-initialize, 400 from the SDK when unsupported), correlation id header. HTTP errors are RFC 9457 Problem Details.
- Tool errors: `isError: true` + `structuredContent` `{ code, category, message, retryable, retryAfterMs?, details? }`; unknown tool → JSON-RPC `-32602`; thrown exception → `unexpected_error` (logged, no internals leaked); output breaking its schema → `output_schema_violation`.

## Commands
```bash
pnpm install
pnpm test            # unit tests (Vitest, 2 workers)
pnpm test:e2e        # SDK client over real HTTP
pnpm inspector:e2e   # MCP Inspector CLI against the real server
pnpm bench           # local p50/p95/p99
pnpm control         # shows why outputSchema must admit the error envelope
```
Local run: `MCP_CLIENT_TOKENS=inspector=<32+ chars> pnpm start` (listens on 127.0.0.1:3000/mcp).
