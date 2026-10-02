# The agent on AgentCore Runtime

How the agent (`apps/agent`) runs on Amazon Bedrock AgentCore Runtime, and who may reach it. Decisions taken in #17 (G1).

## What runs

- **One CommonJS file**: `dist/agentcore/app.js`, built by `pnpm --filter @cold-reserve/agent bundle` (esbuild, Node 22), next to a `package.json` that says `commonjs`. Direct code deployment accepts only a `.js` entry point.
- **The HTTP protocol contract** of AgentCore:
  - it listens on `0.0.0.0:8080`;
  - `GET /ping` answers `{"status":"Healthy"}`, with no `time_of_last_update`, so idle sessions can time out;
  - `POST /invocations` takes `{prompt, home, correlationId?}` and answers a `TurnReply`.
- **The model comes from config**: Bedrock with `AGENT_MODEL_ID` and `AGENT_REGION` (Nova 2 Lite), and `maxTokens` at most 400 (cost rule). Locally and in tests the model is the fake one, and no test calls Bedrock.
- **Idle sessions end after 120 s** (`idleRuntimeSessionTimeout`, set in the infra stack, G1b).
- **No tracing (ADOT) for now.** It works only with CommonJS plus vendored `node_modules`, and the `opentelemetry-instrument` prefix. The bundle keeps that door open; it is not needed for the hackathon.

## Who may call it

- **Only through `InvokeAgentRuntime`, authenticated by IAM (SigV4).** The runtime has no OAuth authorizer, and the container does no bearer check: AgentCore has already authenticated the caller.
- **Only the sim-api role** may call `bedrock-agentcore:InvokeAgentRuntime`, and only on this runtime's ARN (least privilege, G1b and G1c). No user, browser or other service gets that permission.
- **`AGENT_INVOKE_TOKEN` exists only on the local entry** (`src/local.ts`, loopback), where there is no IAM in front.
- **What a caller can do once inside** is still bounded by the code:
  - sandbox homes only (`demo#<16 hex>`), never the real home;
  - an 8 KB body;
  - one turn at a time per home;
  - the turn deadline.

## The MCP token

- The agent reaches the MCP server with its own token: an **SSM SecureString**, encrypted with the AWS-managed key (no extra cost), named by `AGENT_MCP_TOKEN_PARAMETER`.
- It is **read when the first invocation needs it**, with an explicit timeout (`AGENT_SSM_TIMEOUT_MS`, 2 s by default), then **kept in memory only**. It is never logged and never put in a message.
- **If SSM does not answer**, that invocation gets a 503 `config_unavailable`, `/ping` stays healthy, and the next invocation tries again. A missing or denied parameter is `invalid_config`.
- The runtime role needs `ssm:GetParameter` on that one parameter, and `kms:Decrypt` only through SSM (G1b).
- **Logs**: the runtime role may create and write the runtime's log groups and streams under `/aws/bedrock-agentcore/runtimes/`, put a resource policy on its own groups (`<runtime name>-*`) and list log groups, as the AWS execution role template does ([runtime permissions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html)). X-Ray and `cloudwatch:PutMetricData` stay out: only ADOT tracing needs them.

## Errors seen by the caller

When the container answers a 4xx or 5xx, AgentCore returns **424 `RuntimeClientError`** to the caller, without the container's body. So (approved in #17, G1c):

- **Expected failures are a 200 `TurnFailure`** (`packages/contracts`, `turn.ts`): `{failed: true, code, category, retryAfterMs?, correlationId}`, never free text. On the AgentCore entry this covers turn failures, refused invocations, and the MCP token not readable yet. The local entry keeps Problem Details.
- **Only an unexpected throw is a real 5xx** (the Node adapter's last resort), which the caller sees as a 424.
- **sim-api's AgentCore adapter** (`apps/sim-api/src/adapters/agentcore.ts`) calls `InvokeAgentRuntime` with the SDK, signed by sim-api's role, with one runtime session per sandbox home (a hash of the home). It turns:
  - a `TurnFailure` back into the same error, with a fixed message (`fromAgentFailure`, shared with the HTTP adapter). An agent refusal of sim-api itself becomes `unexpected_error`, logged with the agent's code;
  - a 424, the other transient AWS errors and network failures (no HTTP answer) into `agent_unavailable` (dependency_unavailable); a bare `TypeError` or a throw that is not an Error is a bug of ours and becomes `unexpected_error`;
  - access, validation and not-found errors into `unexpected_error`.

  Every failure is logged with its error name and HTTP status, never the SDK text.
- **End to end without AWS**: `apps/sim-api/test/e2e/agentcore.test.ts` runs the real SDK client against a local stand-in for AgentCore, in front of the real agent and MCP server.

## Sources

- [HTTP protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html) (host, port, ARM64, `/ping`, `/invocations`, error codes)
- [Direct code deployment for Node.js](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-node.html) (`.js` entry point, esbuild bundle, CommonJS for ADOT, arm64, size limits)
