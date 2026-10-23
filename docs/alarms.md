# Alarm notifications

Every alarm of the sim-api and MCP server stacks (Errors, DurationP95, InternalErrors, CodeAttemptsGlobalCap) notifies
one SNS topic per stage, `cold-reserve-<stage>-alarms` (foundation stack), which sends an email to the owner. The topic
accepts publishing only over TLS and only from CloudWatch alarms of the same account and region.

Before the first deploy of a stage (owner):

1. Create the parameter with the owner's email, as a **String** (not SecureString: CloudFormation reads it at deploy
   time, and a SecureString cannot be used there). Without it the foundation stack fails to deploy.

```powershell
aws ssm put-parameter --region us-east-1 --name /cold-reserve/dev/alarms/email --type String --value "<owner's email>"
```

2. Deploy. AWS then sends "AWS Notification - Subscription Confirmation" to that address: open it and confirm.
   Until the subscription is confirmed no alarm email arrives (the alarms still show in the CloudWatch console).

The address is never in the repo or the template: `cold-reserve:alarms.emailParameter` in `infra/cdk.json` only names
the parameter.
