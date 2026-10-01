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

## Errors seen by the caller

When the container answers a 4xx or 5xx, AgentCore returns **424 `RuntimeClientError`** to the caller. Our Problem Details may therefore not reach sim-api as they are. sim-api's AgentCore adapter (G1c) handles that.

## Sources

- [HTTP protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html) (host, port, ARM64, `/ping`, `/invocations`, error codes)
- [Direct code deployment for Node.js](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-node.html) (`.js` entry point, esbuild bundle, CommonJS for ADOT, arm64, size limits)
