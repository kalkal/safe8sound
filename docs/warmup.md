# Keeping sim-api and the MCP server warm during judging (#407)

A Lambda container that has been idle for a while is dropped, and the next request pays a cold start (about 0.7 s on sim-api). During the judging window an EventBridge schedule invokes the sim-api and MCP server functions every 5 minutes, so a judge's first tap finds them warm.

## What it does

- One EventBridge rule in the sim-api stack and one in the MCP stack of the stage, `rate(5 minutes)`, each with a single target: its own function, invoked directly with the fixed event `{"source":"cold-reserve.warmup","version":1}`. A missed ping is not retried.
- The AgentCore agent is never pinged (it would spend Nova). No provisioned concurrency (about 24 USD for the same effect).
- The handler recognises the event before anything else and only builds its handler, exactly as a first request would (the SSM reads through the extension, once per container). It never runs a request: no DynamoDB, no caps, no demo code or token check. It writes one `info` line, `message: "warmup"`, `correlationId: "warmup"`, `details.cold` saying whether this ping paid for the build. A failed build writes the usual startup failure line (with `correlationId: "warmup"`) and is retried on the next ping or request, as for a request.

## Why it cannot be used to skip the checks

- The warm-up shape is checked strictly: a plain object with exactly the keys `source` and `version` and those values (`isWarmupEvent`, `packages/core/src/warmup.ts`). A Function URL request (direct or through CloudFront) always arrives as a payload 2.0 event with `version`, `rawPath`, `headers` and `requestContext` at the top level, and the caller cannot write any top-level key, so a request carrying the warm-up object in its body, path, query or headers is handled as an ordinary request (tests in `apps/sim-api/test/lambda.test.ts` and `apps/mcp-server/test/lambda.test.ts`).
- The exact shape only arrives through a direct `lambda:InvokeFunction`, and the only grant for it is the rule's: principal `events.amazonaws.com`, limited to that rule's ARN, on that one function (`infra/test/warmup.test.ts`).
- Even a forged warm-up would only build the handler and return 204: it reaches no tool, no state and no quota.

## Switching it on and off

It is off on every stage by default. The switch is per stage in `infra/cdk.json`:

```json
"cold-reserve:warmup": {
  "enabled": { "dev": false, "demo": false },
  "rateMinutes": 5
}
```

1. Before the judging window (9 November), set `enabled.<stage>` to `true` for the stage the judges use (`demo`, or `dev` if that is where they are), on the branch that stage is deployed from (`release/amazon` after the freeze), and deploy that stage's `sim-api` and `mcp` stacks. The MCP p95 latency alarm may see one extra cold ping per 5-minute period; a single breach there during judging is the warm-up, not a regression.
2. Check it: in the two log groups, one `"message":"warmup"` line per function every 5 minutes.
3. After the window (3 December), set it back to `false` and deploy the same two stacks: the rules and their permissions are removed. Each rule lives in its own function's stack, so nothing is left behind in another stack.

`rateMinutes` accepts 1 to 14: an idle container is usually kept for 5 to 15 minutes, so 5 keeps it warm and more risks losing it.

## Cost

For 25 days, two functions, one ping every 5 minutes: 14,400 invocations.

- Lambda requests: 14,400 × 0.20 USD per million ≈ 0.003 USD.
- Lambda duration (arm64, 512 MB): a warm ping takes a few milliseconds, about 36 GB-s in total ≈ 0.0005 USD; a cold ping (about 1.5 s) happens only when AWS recycles a container. Even if one ping in ten were cold, about 0.015 USD.
- CloudWatch Logs: about 1.2 KB per ping (our line plus the platform's START/END/REPORT) ≈ 17 MB ≈ 0.009 USD.
- EventBridge scheduled rules and standard SSM parameter reads: no charge.

Total about 0.03 USD for the window, before the Lambda free tier.
