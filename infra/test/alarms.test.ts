import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type InfraConfig } from '../src/index.js';
import { SITE_DIR, exampleConfig } from './fixtures.js';

// One notification channel for the alarms (security review, 22 Oct): an SNS topic per stage with an email subscription to
// the owner. The address is never in the repo: CloudFormation reads it from an SSM parameter the owner creates
// (/cold-reserve/<stage>/alarms/email) when the stack is deployed. The owner confirms the subscription from the email AWS sends.

const config: InfraConfig = exampleConfig();
let templates: Record<string, Template>;

beforeAll(() => {
  const app = buildApp(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), config, SITE_DIR);
  templates = Object.fromEntries(
    app.node
      .findAll()
      .filter((c): c is Stack => Stack.isStack(c))
      .map((s) => [s.stackName, Template.fromStack(s)]),
  );
}, 90_000);

const tpl = (name: string) => {
  const t = templates[name];
  if (!t) throw new Error(`No stack ${name}`);
  return t;
};

describe('alarm notifications', () => {
  it('has one topic per stage with an email subscription whose address comes from SSM, never from the repo', () => {
    const t = tpl('cold-reserve-dev-foundation');
    t.resourceCountIs('AWS::SNS::Topic', 1);
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: Match.objectLike({ Ref: Match.anyValue() }) });
    const template = t.toJSON() as { Parameters?: Record<string, { Type: string; Default?: string }> };
    const params = Object.values(template.Parameters ?? {});
    expect(params.some((p) => p.Type === 'AWS::SSM::Parameter::Value<String>' && p.Default === '/cold-reserve/dev/alarms/email')).toBe(true);
    expect(JSON.stringify(t.toJSON())).not.toMatch(/@/);
  });

  it("lets CloudWatch alarms of this account and region publish to the topic, next to the TLS-only Deny (the policy's Deny alone would block them)", () => {
    const t = tpl('cold-reserve-dev-foundation');
    t.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Principal: { Service: 'cloudwatch.amazonaws.com' },
            Action: 'sns:Publish',
            Condition: {
              StringEquals: { 'aws:SourceAccount': Match.anyValue() },
              ArnLike: { 'aws:SourceArn': Match.anyValue() },
            },
          }),
        ]),
      }),
    });
    const policy = JSON.stringify(t.findResources('AWS::SNS::TopicPolicy'));
    expect(policy).toContain(':alarm:*');
  });

  it('sends every alarm of the sim-api and the MCP server to that topic', () => {
    for (const stack of ['cold-reserve-dev-sim-api', 'cold-reserve-dev-mcp']) {
      const alarms = Object.values(tpl(stack).findResources('AWS::CloudWatch::Alarm')) as { Properties: { AlarmActions?: unknown[] } }[];
      expect(alarms.length, stack).toBeGreaterThan(0);
      for (const alarm of alarms) expect(alarm.Properties.AlarmActions?.length, stack).toBe(1);
    }
  });
});
