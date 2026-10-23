# Nova kill switch (runbook, not automated)

When Bedrock spend must stop at once (a budget alarm, a flood of turns, an abuse), without waiting for a deploy. Only the
owner runs these commands, from her own PC with her AWS SSO session (`aws sso login` first): they change IAM or Lambda
settings of the live stage, which agents never do. Every step has its undo. Stage `dev`, region `us-east-1` (from
`infra/cdk.json`); for another stage replace `dev` in the stack names.

Who calls Bedrock: the agent on **AgentCore Runtime** (`infra/src/agent-stack.ts`, its own IAM role with
`bedrock:InvokeModel*` on the configured model only). The sim-api Lambda only calls that runtime. So there is no
"Lambda that calls Bedrock" to set to zero concurrency; the three levels below go from the narrowest to the widest.

## Level 1 — Nova only (recommended): deny Bedrock to the agent's role

Effect: every turn fails as `agent_unavailable` (the page shows its failed-turn message); sessions, cards, the clock,
the phone and the settings keep working. Denied Bedrock calls are not billed. IAM applies it within seconds.

1. Find the agent's role name (the stack's `Role`: CDK helper roles in the same stack are left out):

```powershell
aws cloudformation list-stack-resources --region us-east-1 --stack-name cold-reserve-dev-agent --query "StackResourceSummaries[?ResourceType=='AWS::IAM::Role' && starts_with(LogicalResourceId, 'Role')].PhysicalResourceId" --output text
```

   It prints one name. If it prints none or more than one, stop and ask: do not deny Bedrock to a role you are not sure of.

2. Write the deny policy to a file (`nova-off.json`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "NovaOff", "Effect": "Deny", "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], "Resource": "*" }
  ]
}
```

3. Switch Nova off (replace `<agent-role>` with the name from step 1):

```powershell
aws iam put-role-policy --role-name <agent-role> --policy-name nova-off --policy-document file://nova-off.json
```

Undo (Nova on again):

```powershell
aws iam delete-role-policy --role-name <agent-role> --policy-name nova-off
```

Check: ask the site a question; the agent's log group (`/aws/bedrock-agentcore/runtimes/cold_reserve_dev_agent-*`)
shows the model error, and no new Bedrock invocations appear in CloudWatch (`AWS/Bedrock`, `Invocations`).
The `nova-off` policy is outside CDK: a deploy does not remove it, so delete it on purpose when Nova should come back.

## Level 2 — the whole site's API at once: sim-api concurrency 0

Effect: every API call (code, turns, cards, phone, speech) is throttled; the page cannot even open a session. No Bedrock,
no Polly, no DynamoDB writes. Use it only when Level 1 is not enough (for example Polly or DynamoDB spend too).

1. Find the sim-api function name (the stack's `Api` function: its name starts with `cold-reserve-dev-sim-api-Api`; if the list shows other functions, such as a CDK helper, leave them):

```powershell
aws cloudformation list-stack-resources --region us-east-1 --stack-name cold-reserve-dev-sim-api --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text
```

2. Switch it off:

```powershell
aws lambda put-function-concurrency --region us-east-1 --function-name <sim-api-function> --reserved-concurrent-executions 0
```

Undo:

```powershell
aws lambda delete-function-concurrency --region us-east-1 --function-name <sim-api-function>
```

## Level 3 — planned and polite: the demo switched off by config

`SIM_DEMO_ENABLED=false` on the sim-api (`apps/sim-api/src/config.ts`): every request answers `demo_disabled`, "The demo is
switched off right now.", which the code field shows in plain words. It needs a config change and a deploy (with the
owner's OK), so it is for a planned pause, not an emergency.

## After any level

Write one line in the main's RIPRESA (what, when, why) and tell the main; check the budget alarms the next morning.
