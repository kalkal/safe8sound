import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AlexaConfigSchema, AlexaSkillIdSchema, buildApp, type InfraConfig } from '../src/index.js';
import { SITE_DIR, exampleConfig } from './fixtures.js';

// Template assertions for the classic Alexa skill bridge (#26). Bundling is skipped here; `pnpm synth` bundles it.
// A fake skill ID only: the real one is given at deploy time and never lands in the repo.
const FAKE_SKILL_ID = 'amzn1.ask.skill.00000000-0000-0000-0000-000000000000';
const config: InfraConfig = exampleConfig();

const stackNames = (app: App) => app.node.findAll().filter((c): c is Stack => Stack.isStack(c)).map((s) => s.stackName);
const synth = (skillId?: string, cfg: InfraConfig = config) => buildApp(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), cfg, SITE_DIR, skillId);
const skillTemplate = (app: App) => {
  const stack = app.node.findAll().find((c): c is Stack => Stack.isStack(c) && c.stackName === 'cold-reserve-dev-alexa-skill');
  if (!stack) throw new Error('No alexa-skill stack');
  return Template.fromStack(stack);
};

let template: Template;
let names: string[];
beforeAll(() => {
  const app = synth(FAKE_SKILL_ID);
  app.synth(); // the cdk-nag AwsSolutions checks run here with the skill stack in: any finding fails the test
  names = stackNames(app);
  template = skillTemplate(app);
}, 90_000);

describe('the alexa-skill stack', () => {
  it('exists only with a skill ID, and only on the stages the config names (dev)', () => {
    expect(names).toContain('cold-reserve-dev-alexa-skill');
    expect(names).not.toContain('cold-reserve-demo-alexa-skill');
    expect(stackNames(synth()).filter((n) => n.includes('alexa-skill'))).toEqual([]);
  }, 90_000);

  it('is one arm64 nodejs22.x function, 7 s, no reserved concurrency by default, JSON logs, with the timings and names in its env', () => {
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'cold-reserve-dev-alexa-skill',
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Timeout: 7,
      ReservedConcurrentExecutions: Match.absent(),
      LoggingConfig: Match.objectLike({ LogFormat: 'JSON' }),
      Environment: {
        Variables: Match.objectLike({
          ALEXA_SKILL_ID: FAKE_SKILL_ID,
          ALEXA_MCP_TOKEN_PARAMETER: '/cold-reserve/dev/alexa-skill/mcp-token',
          ALEXA_DEADLINE_MS: '6000',
          ALEXA_SSM_TIMEOUT_MS: '1500',
          ALEXA_MCP_TIMEOUT_MS: '4000',
          ALEXA_TEMP_UNIT: 'C',
          ALEXA_MCP_URL: { 'Fn::Join': ['', [Match.anyValue(), 'mcp']] },
        }),
      },
    });
  });

  it('reserves concurrency only when the config asks (a new account refuses any reservation)', () => {
    const reserved = skillTemplate(synth(FAKE_SKILL_ID, { ...config, alexa: { ...config.alexa, reservedConcurrency: 2 } }));
    reserved.hasResourceProperties('AWS::Lambda::Function', { ReservedConcurrentExecutions: 2 });
  }, 90_000);

  it('may be invoked only by the Alexa Skills Kit for this skill ID', () => {
    template.resourceCountIs('AWS::Lambda::Permission', 1);
    template.hasResourceProperties('AWS::Lambda::Permission', { Action: 'lambda:InvokeFunction', Principal: 'alexa-appkit.amazon.com', EventSourceToken: FAKE_SKILL_ID });
    template.resourceCountIs('AWS::Lambda::Url', 0);
  });

  it('reads one SSM parameter and nothing else: no Bedrock, no Secrets Manager, no DynamoDB', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (p) => (p as { Properties: { PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] } } }).Properties.PolicyDocument.Statement,
    );
    const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions.filter((a) => !a.startsWith('logs:'))).toEqual(['ssm:GetParameter']);
    const ssm = statements.find((s) => s.Action === 'ssm:GetParameter');
    expect(JSON.stringify(ssm?.Resource)).toContain(':parameter/cold-reserve/dev/alexa-skill/mcp-token');
    expect(JSON.stringify(statements)).not.toMatch(/bedrock|secretsmanager|dynamodb/);
  });

  it('keeps its logs 14 days and outputs the function ARN for the developer console', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });
    template.hasOutput('AlexaSkillFunctionArn', { Value: { 'Fn::GetAtt': [Match.anyValue(), 'Arn'] } });
  });
});

describe('the alexa config', () => {
  it('refuses timings that do not fit: SSM + MCP over the deadline, or a deadline the function does not outlive', () => {
    expect(AlexaConfigSchema.safeParse(config.alexa).success).toBe(true);
    expect(AlexaConfigSchema.safeParse({ ...config.alexa, mcpTimeoutMs: 5000 }).success).toBe(false);
    expect(AlexaConfigSchema.safeParse({ ...config.alexa, deadlineMs: 7000 }).success).toBe(false);
    expect(AlexaConfigSchema.safeParse({ ...config.alexa, timeoutSeconds: 8 }).success).toBe(false);
  });

  it('accepts only a well-formed skill ID', () => {
    expect(AlexaSkillIdSchema.safeParse(FAKE_SKILL_ID).success).toBe(true);
    expect(AlexaSkillIdSchema.safeParse('amzn1.ask.skill.nope').success).toBe(false);
  });
});
