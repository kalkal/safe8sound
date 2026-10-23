# The classic Alexa skill "safe eight sound" (#26)

A bridge until the Alexa+ add-on is available: a classic custom skill whose Lambda calls the MCP server directly.
No model, no Bedrock, no AgentCore, no Docker, no Secrets Manager. The design of the request routing and of
`skill-package/` is adapted from [alexa-skill-mcp-bridge](https://github.com/KayLerch/alexa-skill-mcp-bridge)
(Apache-2.0, see `NOTICE`); no source file was copied.

## Flow

```
Alexa (Development) ──► cold-reserve-dev-alexa-skill (Lambda, arm64, Node 22, 7 s)
                          1. Zod check of the envelope, then the skill ID (2nd check; 1st = Lambda permission)
                          2. route: Launch / ReserveOutlookIntent / SafeRoomIntent → one tool; built-ins → no call
                          3. MCP token from SSM (/cold-reserve/dev/alexa-skill/mcp-token), kept after the first success
                          4. one stateless MCP tools/call (Bearer read:alexa@demo token, x-correlation-id)
                          5. structuredContent checked against the tool's output schema → fixed English sentence
                     ◄── SSML response (plain text escaped inside <speak>)
```

| Request | Tool | Answer | Session |
|---|---|---|---|
| LaunchRequest ("open safe eight sound") | `get_home_status` | "This is the simulated demo home." (once, only here) + battery %, level, rooms served, grid | stays open |
| ReserveOutlookIntent | `get_reserve_outlook` | hours at the current level, at essential, storm reserve | open, or ends for a one-shot "ask ..." |
| SafeRoomIntent | `get_safe_room_status` | room, temperature (unit from config), people count, safe hours | as above |
| AMAZON.HelpIntent / FallbackIntent / unknown intent | none | menu | stays open |
| AMAZON.Stop / Cancel / NavigateHome | none | "Goodbye." | ends |
| SessionEndedRequest, other types | none | empty response | — |

Every number spoken comes from the tool's `structuredContent` ([speech.ts](../apps/alexa-skill/src/speech.ts));
a test feeds other values and checks other numbers come out.

## Timing

Alexa waits 8 s. The function times out at 7 s. Inside it, one deadline of 6.9 s covers the whole request; the SSM read
has 1.2 s and the MCP call 5.7 s, both also bounded by the deadline (`AbortSignal.any`). Until 23 Oct the MCP call had
4 s: the first call after a pause (the skill's and the MCP server's cold starts together) timed out at 5.3 s. Config:
`infra/cdk.json` `cold-reserve:alexa`; the schema refuses SSM + MCP over the deadline, or a deadline the function
does not outlive. The SSM read happens only on a cold container (a success is kept).

## Errors (values, never thrown)

| Failure | Code (log) | Level | Spoken |
|---|---|---|---|
| SSM slow / extension starting | `config_unavailable` | warn | "I cannot reach the home right now..." |
| SSM setup (name, permission) | `invalid_config` | error | "Something went wrong on our side..." |
| MCP over 5.7 s or the deadline | `agent_timeout` | warn | "The home did not answer in time..." |
| MCP 401/403 (token not in MCP clients) | `wrong_client` | error | "Something went wrong on our side..." |
| MCP unreachable | `agent_unavailable` | warn | "I cannot reach the home right now..." |
| tool `isError` | the tool's own code | by category | by retryable |
| bad CallToolResult / schema | `output_schema_violation` | error | "The home sent an answer I could not read..." |
| another skill's applicationId | `wrong_client` | warn | empty response, MCP never called |

Logs: one JSON line per request (`@cold-reserve/core` `loggerTo` + `jsonLineSink`, the shared `LogEntry`), with
a fresh correlation id that the MCP server logs too. Never the user, device or session id, the apiAccessToken,
the MCP token, the Alexa request id or any error text (only `errorName`).

## Deploy (owner's OK; agents never deploy)

1. Create the SSM SecureString `/cold-reserve/dev/alexa-skill/mcp-token` with a new token (32+ characters).
2. Add `read:alexa@demo=<same token>` to the MCP clients SecureString `/cold-reserve/dev/mcp-server/clients`. The
   `read` scope lets the token call only `get_home_status`, `get_reserve_outlook` and `get_safe_room_status`; any
   other tool call (batches too) is refused with 401 `wrong_client` ([handler.ts](../apps/mcp-server/src/handler.ts),
   `READ_SCOPE_TOOLS` in [config.ts](../apps/mcp-server/src/config.ts)).
3. Make the MCP server read the new list. It reads that parameter once per container and keeps it
   ([lambda-main.ts:30-33](../apps/mcp-server/src/lambda-main.ts), cached in `createLambdaHandler`), and a redeploy
   with no change to the function leaves the warm containers as they are. Force new containers with a real
   configuration change, for example
   `aws lambda update-function-configuration --function-name <McpServer function name> --description "clients <date>"`.
   Until then the skill gets 401 `wrong_client` (it says "Something went wrong on our side").
4. `pnpm synth`, then deploy with the skill ID on the command line or in the deployer's environment (never in `cdk.json`):
   `cdk deploy "dev/alexa-skill" -c alexaSkillId=amzn1.ask.skill.<uuid>`, or `ALEXA_SKILL_ID` set for every deploy so
   the skill stack goes out with the rest. A synth without it warns `alexa_skill_left_out`: the skill then keeps its last
   deployed code, and its strict schemas refuse the newer MCP fields (23 Oct: 13 Oct's code answered "The home sent an
   answer I could not read" to every launch). `cdk list` with the same `-c` shows the
   stack as `dev/alexa-skill (cold-reserve-dev-alexa-skill)`; without `alexaSkillId` it is not in the app at all.
5. Reserved concurrency: none by default, because a new account (limit 10, AWS keeps 10 unreserved) refuses any
   reservation. Once the quota is raised, set `reservedConcurrency: 2` in `cold-reserve:alexa`.

The `demo` home on dev answers `get_home_status` without seeding: it is always registered, backed by the simulator
on the stage's scenario (`clear-day`, anchored daily); only `get_safe_room_status` also reads the store, and degrades
to the live reading when the store is down. This follows from the code; it was not called on dev from here.

## Developer console (owner, one step at a time)

1. Build → Interaction Model → JSON Editor → paste `apps/alexa-skill/skill-package/interactionModels/custom/en-US.json` → Save → Build skill.
2. Build → Endpoint → AWS Lambda ARN = the `AlexaSkillFunctionArn` output → Save.
3. Test → "Development" → type "open safe eight sound", then "how long the reserve lasts", "help", "stop".

## Local run

`pnpm test apps/alexa-skill` runs the unit tests and the scripted session (`test/fixtures`: Launch, ReserveOutlook,
Help, Stop) against the real local MCP server started with a throwaway `read:alexa@demo` token.
