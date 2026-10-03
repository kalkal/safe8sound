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

If DynamoDB is throttled, has a server fault, times out or cannot be reached, the request fails closed with a retryable 503 `store_unavailable` (the error name in the log, never in the answer). Any other store error is a bug of ours: 500 `unexpected_error`, logged. A cap is never skipped.

## Who may do what (IAM)

The function has its own role, with no managed policies:

- `bedrock-agentcore:InvokeAgentRuntime` on the agent runtime of the same stage and its `DEFAULT` endpoint, and nothing else (the action needs both resource types);
- `dynamodb:UpdateItem` on the state table, only for partition keys starting with `DEMO#` (`dynamodb:LeadingKeys`);
- `ssm:GetParameter` on the three parameters above;
- `polly:SynthesizeSpeech` (its only resource type is a custom lexicon; we use none, so the resource is `*`);
- `s3:GetObject` and `s3:PutObject` on `speech/*` in its own cache bucket, and nothing else in S3;
- writing to its own log group.

## The browser side

- **CORS** is answered by the handler only, for the exact simulator origins in `SIM_ALLOWED_ORIGINS`: preflight `OPTIONS` (`POST` only, the headers `authorization`, `content-type` and `x-correlation-id`), and `Access-Control-Allow-Origin` with `x-correlation-id` exposed on every answer to an allowed origin. Any other origin gets `origin_not_allowed`. The Function URL has **no CORS configuration** of its own: for `POST`, Lambda would send its CORS headers as well as the function's, and the browser refuses two `Access-Control-Allow-Origin` values (review of #156). Until the web stack sets an origin, the function answers `invalid_config`.
- **Kill switch**: `demoEnabled` per stage in the CDK config; when off, every POST to a demo route answers `demo_disabled`.

## Spoken replies (Amazon Polly, F8d)

The answers can be read aloud in a studio voice (Amazon Polly, neural, en-US; the voice id is one setting, `SIM_SPEECH_VOICE`, default `Joanna`). The design was approved in #25:

- **Only real replies are spoken.** When speech is on, a turn reply carries `speech.ticket`: an HMAC-SHA256, with the token signing key, over the token's `jti`, the engine, the voice and the reply text. `POST /v1/speech {text, ticket}` speaks that exact text only; any other text, token or voice is `invalid_input`. The ticket needs no storage and expires with the token.
- **Cache first.** The audio of a text is kept in the stage's S3 bucket under `speech/<sha256(engine|voice|mp3|text)>.mp3`, so a phrase is synthesized once (the scripted demo phrases cost nothing after the first time). The bucket is private (all public access blocked), encrypted with S3-managed keys, TLS only, and forgets each object after `cacheDays` (30). It is kept on `demo` and dropped with `dev`. A failed cache read or write is logged (`speech_cache_failed`) and the reply is still spoken.
- **Polly.** One `SynthesizeSpeech` per text: plain text only (`TextType: text`, never SSML from a reply), mp3, one attempt with its own timeout (`pollyTimeoutMs`, 2.5 s). Throttling, a Polly fault or the network is 503 `polly_unavailable`; a denied call or an unknown voice is our setup, so it is 500 `unexpected_error` and the internal-errors alarm fires. When Polly answers with an error, nothing was synthesized and the characters go back to the code; a timeout, a cut connection or any error that is not an answer from AWS keeps them counted, because the call may have been billed. When the overall cap refuses, the code's own count goes back; a failed give-back is logged (`speech_refund_failed`) and the refusal stands.
- **Caps.** Characters sent to Polly are counted per demo code and overall per UTC day, on the same atomic `DEMO#` counters (`DEMO#SPEECH#<codeId>#<day>`, `DEMO#SPEECH#GLOBAL#<day>`; defaults 6,000 and 30,000). Cache hits are free.
- **Kill switch.** `SIM_SPEECH_ENABLED` (true or false, off by default; in the CDK config, `speech.enabled` is off on `dev` and on for `demo`): when off, replies carry no ticket and `/v1/speech` answers 503 `polly_unavailable`.
- **Time budget.** A spoken reply's worst case (SSM at a cold start, the cache twice, two counts and two refunds, Polly) must fit in the function timeout like a turn does, so the timeout is 32 s; the config refuses values that would not fit.
- **Failures.** Polly down, slow or refusing is 503 `polly_unavailable`. The browser then reads that reply with its own voice and says so once; the answer is never lost.
- **Privacy.** Only the reply text goes to Polly, never a question, a log line or personal data. Logs carry the demo code id, the number of characters and whether it came from the cache, never the text. Opting out of Polly using the texts to improve Amazon's AI services (AWS Organizations) is the owner's step before the demo deploy.

## Tests

- Unit: `apps/sim-api/test/lambda.test.ts` (the event adapter), `lambda-wiring.test.ts` (secrets from SSM only, settings checked before anything is read), `packages/adapters/store-dynamodb/test/counter.test.ts` (the conditional counter), `infra/test/sim-api-stack.test.ts` (IAM, CORS, env, alarms, cdk-nag).
- End to end without AWS: `apps/sim-api/test/e2e/lambda.test.ts` sends Function URL events through the real wiring and the real AWS SDK client to a local stand-in for AgentCore, including the daily cap and a failing runtime.
