# Error handling

Binding rules for every package and app. Errors are part of the product: a storm is exactly when things fail, and that is when the user must still get a calm, correct answer.

## 1. Principles
1. **Expected errors are values, not exceptions.** Domain and adapter functions return `Result<T, E>` (discriminated union). Exceptions are reserved for bugs and truly unexpected failures.
2. **Never swallow an error.** Every `catch` either handles the error (fallback, retry, user message) or re-throws it with context. No empty `catch`, no `catch` that only logs and continues silently.
3. **Fail safe, not open.** When in doubt, the guard rejects the plan, the real home stays untouched, and the answer says what could not be done and why.
4. **Degrade, don't die.** Every external dependency has a documented degraded mode (see §5): simulator fallback, manual-control instructions, cached forecast, browser speech synthesis.
5. **Everything in English**: error codes, messages, logs, comments and docs.

## 2. Error taxonomy (shared in `packages/contracts`)
Every error carries a stable machine code (`snake_case`), a category and a short English message.

| Category | Examples of codes | Who can fix it | Retry? |
|---|---|---|---|
| `validation` | `invalid_setpoint`, `unknown_room`, `plan_expired`, `last_resort_token_invalid` | the caller / the model | no (fix input) |
| `guard_rejection` | `storm_reserve_violated`, `inverter_limit_exceeded`, `pacing_off_track`, `safe_room_comfort_violated` | the model re-plans; the user may change preferences | no |
| `not_found` | `plan_not_found`, `home_not_found` | caller | no |
| `unauthorized` / `forbidden` | `missing_token`, `wrong_client`, `origin_not_allowed`, `demo_disabled` | configuration | no |
| `conflict` | `plan_already_applied` (idempotent success, not a failure) | nobody: return the original outcome | n/a |
| `dependency_unavailable` | `home_data_stale`, `split_cloud_unreachable`, `forecast_unavailable`, `bedrock_throttled`, `polly_unavailable`, `config_unavailable` (SSM at startup) | transient | yes, with backoff, then degrade |
| `rate_limited` | `demo_quota_exceeded`, `turn_in_progress` (one question at a time per home) | wait | after `retryAfter` |
| `internal` | `unexpected_error` | us (bug) | no; alert |

## 3. Per layer
### Domain (`core`, `guard`)
- Pure functions, no I/O, no exceptions for business outcomes.
- The guard **never modifies** a plan: it returns every guarantee with `ok`, `reason` and the nearest allowed value.

### MCP server (spec 2025-11-25)
- **Protocol errors** (unknown tool, malformed request, server failure) → JSON-RPC `error`.
- **Tool execution errors** (validation, guard rejection, dependency down) → normal result with `isError: true`, a short actionable English text **and** `structuredContent` with `{ code, category, message, retryable, retryAfterMs?, details? }`. The model sees them and can self-correct ([MCP tools spec, Error Handling](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)).
- A tool **always returns something**: never an empty result.
- Validate inputs (Zod) and outputs (`outputSchema`) at the boundary. An output that fails its own schema is an `internal` error, logged with the correlation id.
- Idempotency: a repeated `apply_plan(planId)` returns the original outcome.

### HTTP APIs (`sim-api`, `ingest-api`)
- Errors use **Problem Details, RFC 9457** (`application/problem+json`: `type`, `title`, `status`, `detail`, `instance` + extension `code`) ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)).
- No stack traces, internal ids or secrets in responses. `instance` = correlation id.

### Agent
- Tool errors are passed to the model; the system prompt says: explain in one sentence, never invent numbers, offer the next step.
- Turn budget: timeout per turn and per tool call; after the budget, answer with what is known ("I can't reach the house right now; last reading at 21:10 …").

### Web simulator
- A React error boundary per card and per surface: one broken card never blanks the screen.
- Every data state is explicit: loading, live, simulated, stale ("as of hh:mm"), error (with retry), offline.
- User-facing messages: what happened + what to do, no codes, no "Error:" prefix.
- The XState machine has explicit error states (speech not recognised, agent timeout, audio blocked) with one retry and a text fallback.

### Home bridge
- Never crashes on a bad payload: log, skip, and keep the last good snapshot.
- Queue snapshots locally when offline; send with backoff; drop the oldest beyond a cap.

## 4. Retries, timeouts, backoff
- Every outbound call has an explicit timeout (config, never default-infinite).
- Retry only `dependency_unavailable` and `rate_limited`: exponential backoff with jitter, max 3 attempts, and never retry non-idempotent writes without an idempotency key.
- After repeated failures, a simple circuit breaker opens for a short cool-down and the degraded mode kicks in.

## 5. Degraded modes (one per dependency)
| Dependency down | Degraded mode |
|---|---|
| Real home data stale > 15 min | Simulator fallback, `dataOrigin: simulated`, visible badge |
| Hisense split cloud | Manual-control card: per-room instructions, "done" by voice or touch |
| Weather/air-quality forecast | Last cached forecast with its age; confidence drops to `low` |
| Bedrock / AgentCore | Scripted answers for status questions + clear notice; no actions |
| Polly | Browser speech synthesis |
| DynamoDB | Read-only answers from the current snapshot; preferences changes rejected with a clear message. `get_safe_room_status` (#114): a `store_unavailable` read of the preferences or the storm session still answers the live reading with the default safe room and no storm session, flagged `storeUnavailable`, its hours at the stricter older-person night limit (nobody knows who is home), the text and the card saying so, never "safe" alone; one warn line `storm_read_degraded` with the correlation id. Every write (start_storm_mode, notify_family, a family reply) stays fail-closed. A stored record that cannot be read never names its key in the message: the cause goes to the log through `onError` (`StoredItemNewerSchema`, `StoredItemInvalid`). |

## 6. Observability
- One correlation id per user turn, propagated simulator → sim-api → agent → MCP server → logs (Powertools Logger, JSON).
- Log errors once, at the boundary that handles them, with `code`, `category` and correlation id; no secrets, no personal data.
- Alarms: `internal` errors > 0, tool p95 > 500 ms, cost per day over budget.

### 6.1 Error log you can consult (stored in the database)
Three places, one format (JSON: `ts`, `level`, `code`, `category`, `component`, `message`, `correlationId`, `homeId`, `details`; never secrets or personal data):
1. **Database (DynamoDB, same single table)**: every handled error of category `internal`, `dependency_unavailable`, `guard_rejection` or `unauthorized` is written as an item `PK=HOME#<homeId>` (or `SYSTEM`), `SK=ERROR#<ts>#<code>`, with TTL 90 days. Repeated identical errors are **deduplicated per code per hour** (a counter on one item instead of one item per occurrence), to keep writes and costs bounded.
2. **Diagnostics view** in the desktop "control room" surface (dev and demo stages, behind the demo code): the latest errors filterable by time, component, code and category, each linked to its correlation id; plus a "download as JSON Lines" button (vendor-independent export).
3. **Logs**: CloudWatch Logs (structured JSON, 30-day retention, Logs Insights queries saved in `infra/`) for the cloud parts; locally and on the home bridge a rotating **JSON Lines file** `logs/<component>.log` (ignored by git), max 10 files × 5 MB.

A small CLI (`pnpm errors [--since 24h] [--code ...]`) reads the database log for quick checks from the terminal.

**One line, one shape (#111).**
- `LogEntrySchema` in `packages/contracts` is the line every component writes: `ts`, `level`, `component`, `message`, `correlationId`, plus `code` and `category` (required on warnings and errors, in the category the catalogue gives the code), and the optional `homeId`, `clientId`, `errorName`, `stack` and `details`.
- The schema is strict, so a field nobody declared cannot slip in. `details` carries ids and codes only (a plan id, an operation name), never free text or personal data. `withoutStack` is the copy that may leave the server.
- The `Logger` port in `packages/core` writes those lines. `causeFields(cause, { withStack })` keeps the cause's name, and its stack only server side, never its text.
- The correlation id has one definition: `CORRELATION_ID_HEADER` and `CorrelationIdSchema` (a UUID). `correlationIdFrom(header, fresh)` keeps a well-formed id and makes a fresh one otherwise.
- A store opened with `storeFor(homeId, { correlationId })` reports its failures with that id (`StoreErrorEvent.correlationId`).

**Every tool call (G6, #146).**
- Each MCP `tools/call` leaves one info line: `tools/call <tool>`, with the tool, `durationMs`, the outcome (`ok` or `error`, plus the error code), the correlation id and the home.
- Each call also leaves one latency sample in CloudWatch Embedded Metric Format: metric `ToolLatency` in milliseconds, dimension `Tool`, namespace `MCP_METRICS_NAMESPACE` (default `ColdReserve/Mcp`).
- The sample is a JSON line of its own, because EMF needs its fields at the top level and the log line is strict. On Lambda it goes to stdout; locally there is no metric.

**The home's data source (#113).** `FallbackSource` switches to the simulator when the home's data is stale or lost, and says so in the log: a warning on the switch, with the reason, its category and the name of what was thrown (never its text); an info line when the home answers again. A simulator that fails for a reason a retry cannot fix (a bug, a missing EPS load) is an error with its own code, not a retryable `home_data_stale`.

**Reading what is stored (R7).** Inputs stay strict. Stored items are read with `readStored`, which drops the fields this version does not know at any depth, and with `isReadableSchemaVersion`, which accepts every version up to the current one. So an additive field never breaks an older reader, and a newer version is still refused.

## 7. Tests (unit first, then code, then E2E)
- Every error code has at least one unit test that produces it.
- Contract tests: every tool returns valid `structuredContent` in success **and** failure.
- Fault injection in integration/E2E: home data stale, split cloud down, forecast down, agent timeout, Polly down → assert the degraded mode and the message.
- Property tests: no input makes the guard throw.
