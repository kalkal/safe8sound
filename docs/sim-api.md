# The sim-api on Lambda

The sim-api is the demo API the web simulator calls: it checks the demo code, signs a short-lived token, enforces the caps, and passes each turn to the agent on AgentCore Runtime (#17). Locally it runs as a Node server (`pnpm --filter @cold-reserve/sim-api start`); on AWS it runs as one Lambda behind a Function URL (`infra/src/sim-api-stack.ts`).

## What runs

- **Entry**: `apps/sim-api/src/lambda-main.ts`, arm64 `nodejs22.x`, bundled by CDK. It builds the same Web handler as the local entry (`createSimApiHandler`), once per container; a failed build is not kept and the next request retries.
- **Client IP** for the per-IP cap: the one AWS saw (`requestContext.http.sourceIp`), never `X-Forwarded-For` or another header the caller writes.
- **Logs**: one JSON line per event in the shared `LogEntry` format, Lambda logging format `JSON`. A metric filter counts lines of category `internal` and alarms on the first one; there are also alarms on Lambda errors and on the p95 duration.

## Secrets: SSM SecureStrings only

Three SecureStrings per stage, read through the AWS Parameters and Secrets Lambda extension with an explicit timeout (`SSM_TIMEOUT_MS`). The function's environment holds only their **names**; the values never appear in env, logs or messages.

| Parameter | Content |
| --- | --- |
| `/cold-reserve/<stage>/sim-api/demo-codes` | `<codeId>:<sha256 hex of the code>,...` (only hashes, never the codes) |
| `/cold-reserve/<stage>/sim-api/token-keys` | `<kid>:<base64url key of 32+ bytes>,...` (the first key signs, every key verifies) |
| `/cold-reserve/<stage>/sim-api/mcp-token` | sim-api's own bearer token for the MCP server (32+ characters) |

Creating them is part of a deploy, reserved to the owner. A transient SSM failure answers 503 `config_unavailable` (retry later); a missing or malformed parameter answers a generic 500 `invalid_config`, with the setting's name (never its value) in the log.

## Caps that hold with many instances

The caps live in the shared DynamoDB table, one item per key (sort key `COUNT`), under the `DEMO#` prefix of plan §3.2 (decided in #17):

| Partition key | Cap | Window |
| --- | --- | --- |
| `DEMO#TURNS#<codeId>#<day>` | turns per demo code | UTC day |
| `DEMO#TURNS#GLOBAL#<day>` | turns for everyone | UTC day |
| `DEMO#TOOLS#<codeId>#<day>` | card actions per demo code | UTC day |
| `DEMO#ATTEMPT#<salted hash of the IP>#<hour>` | wrong demo codes per client IP | UTC hour |

The client IP is personal data, and the table keeps 35 days of point-in-time backups (and is retained on `demo`): the key holds only an HMAC-SHA256 of the IP, salted with the token signing key from SSM, never the IP itself; the IP is never logged either. A key rotation only resets the current hour's attempt counts. Each use is **one atomic `UpdateItem`**: `ADD` one, on the condition that the item is new or still under the limit. At the cap the condition fails and nothing is counted.

A demo code attempt is counted **before** the code is compared, so concurrent guesses cannot slip past the cap, and past the cap even a right code is refused. A right code then gives its attempt back (`ADD -1`, never below zero), so only wrong codes stay counted: a jury behind one shared IP can open as many sessions as it needs, within the daily caps per code and overall (review of #139). If the give-back fails, the session still opens and the line `attempt_release_failed` is logged. Each item carries a `ttl` at the end of its window, so DynamoDB removes old counters. The limits come from the CDK config (`cold-reserve:simApi` → `limits`), never from code.

If DynamoDB fails for another reason, the request fails closed (500 `unexpected_error`, logged): a cap is never skipped.

## Who may do what (IAM)

The function has its own role, with no managed policies:

- `bedrock-agentcore:InvokeAgentRuntime` on the agent runtime of the same stage and its `DEFAULT` endpoint, and nothing else (the action needs both resource types);
- `dynamodb:UpdateItem` on the state table, only for partition keys starting with `DEMO#` (`dynamodb:LeadingKeys`);
- `ssm:GetParameter` on the three parameters above;
- writing to its own log group.

## The browser side

- **CORS** is answered by the handler only, for the exact simulator origins in `SIM_ALLOWED_ORIGINS`: preflight `OPTIONS` (`POST` only, the headers `authorization`, `content-type` and `x-correlation-id`), and `Access-Control-Allow-Origin` with `x-correlation-id` exposed on every answer to an allowed origin. Any other origin gets `origin_not_allowed`. The Function URL has **no CORS configuration** of its own: for `POST`, Lambda would send its CORS headers as well as the function's, and the browser refuses two `Access-Control-Allow-Origin` values (review of #156). Until the web stack sets an origin, the function answers `invalid_config`.
- **Kill switch**: `demoEnabled` per stage in the CDK config; when off, every POST to a demo route answers `demo_disabled`.

## Tests

- Unit: `apps/sim-api/test/lambda.test.ts` (the event adapter), `lambda-wiring.test.ts` (secrets from SSM only, settings checked before anything is read), `packages/adapters/store-dynamodb/test/counter.test.ts` (the conditional counter), `infra/test/sim-api-stack.test.ts` (IAM, CORS, env, alarms, cdk-nag).
- End to end without AWS: `apps/sim-api/test/e2e/lambda.test.ts` sends Function URL events through the real wiring and the real AWS SDK client to a local stand-in for AgentCore, including the daily cap and a failing runtime.
