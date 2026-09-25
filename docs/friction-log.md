# Friction log

One entry per friction met while building with the hackathon tools (for the Devpost friction log).

| Date | Task | Steps | Expected | Actual | Severity | Workaround | Suggestion |
|---|---|---|---|---|---|---|---|
| 2026-09-25 | Connect an MCP server to Alexa+ | Read the Alexa+ MCP Toolkit docs | Developer access for hackathon participants | Toolkit available to select partners only, US only | High | Simulated Alexa+ experience + classic Skill bridge | Open a sandbox of the toolkit to hackathon participants |
| 2026-09-25 | S1: MCP tool errors with `structuredContent` | Tool with `outputSchema` returns `isError: true` + error envelope in `structuredContent`; call it with the TypeScript SDK client v1.30.1 | Client skips output validation on error results (as its own code comment says) | Client validates the error envelope against `outputSchema` and throws -32602 | Medium | Advertise `outputSchema` as `anyOf [success, error envelope]` | Skip `structuredContent` validation when `isError` is true, or document the union pattern |
| 2026-09-25 | S1: MCP Inspector CLI in CI with a static bearer token | `mcp-inspector --cli <url> --header "Authorization: Bearer <bad>"` | Non-zero exit with the 401 | Starts interactive OAuth, fails with `auth_required` "requires a TTY" | Low | Add `--stored-auth-only` in CI | Make non-interactive the default when stdin is not a TTY |
