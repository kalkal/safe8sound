import { ArnFormat, Stack, Stage, Validations, type App, type StackProps } from 'aws-cdk-lib';
import { Effect, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { Construct } from 'constructs';
import type { InfraConfig, StageName } from './config.js';
import { AgentStack } from './agent-stack.js';
import { AlexaStack } from './alexa-stack.js';
import { DataStack } from './data-stack.js';
import { McpStack } from './mcp-stack.js';
import { SimApiStack } from './sim-api-stack.js';
import { WebStack } from './web-stack.js';

/**
 * The shared resources of a stage (the web, agent and data stacks have their own): the topic every alarm notifies
 * (security review, 22 Oct), with an email subscription to the owner. The address lives in an SSM String the owner
 * creates before the deploy (`emailParameter`); CloudFormation reads it at deploy, so it is never in the repo or the
 * template. AWS then sends a confirmation email: the subscription works once the owner confirms it.
 */
export class FoundationStack extends Stack {
  readonly alarmTopic: Topic;

  constructor(scope: Construct, id: string, props: StackProps & { readonly stage: StageName; readonly alarms: InfraConfig['alarms'] }) {
    super(scope, id, props);
    this.alarmTopic = new Topic(this, 'Alarms', { topicName: `cold-reserve-${props.stage}-alarms`, enforceSSL: true });
    // A topic with a policy (the TLS-only Deny above) takes no publisher it does not name: CloudWatch alarms of this
    // account and region are named here, nothing else.
    this.alarmTopic.addToResourcePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        principals: [new ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.alarmTopic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': this.formatArn({ service: 'cloudwatch', resource: 'alarm', resourceName: '*', arnFormat: ArnFormat.COLON_RESOURCE_NAME }) },
        },
      }),
    );
    const email = StringParameter.valueForStringParameter(this, props.alarms.emailParameter.replace('{stage}', props.stage));
    this.alarmTopic.addSubscription(new EmailSubscription(email));
    Validations.of(this.alarmTopic).acknowledge({
      id: 'AwsSolutions-SNS2',
      reason: 'Alarm notifications carry only the alarm name and state, no data; CloudWatch cannot publish to a topic encrypted with the AWS managed SNS key, and a customer key would cost more than the stage itself.',
    });
  }
}

export class ColdReserveStage extends Stage {
  /** `alexaSkillId`: given at deploy time only (`-c alexaSkillId=...`); without it no skill function is created (#26). */
  constructor(scope: Construct, stageName: StageName, config: InfraConfig, siteDir: string, alexaSkillId?: string) {
    super(scope, stageName, { env: { region: config.region } });
    const common = (name: string) => ({
      stackName: `cold-reserve-${stageName}-${name}`,
      // demo is what the judges see: deploys are manual and reserved to the owner.
      terminationProtection: stageName === 'demo',
      tags: { project: 'cold-reserve', stage: stageName },
    });
    const foundation = new FoundationStack(this, 'foundation', { ...common('foundation'), stage: stageName, alarms: config.alarms });
    const data = new DataStack(this, 'data', { ...common('data'), retain: stageName === 'demo' });
    // The scheduled warm-up (#407): on only for the stages the config switches on (the judging window).
    const warmup = config.warmup.enabled[stageName] ? { warmup: { rateMinutes: config.warmup.rateMinutes } } : {};
    const mcp = new McpStack(this, 'mcp', { ...common('mcp'), stage: stageName, mcp: config.mcp, state: config.state, table: data.table, alarmTopic: foundation.alarmTopic, ...warmup });
    const agent = new AgentStack(this, 'agent', { ...common('agent'), stage: stageName, agent: config.agent, turnTiming: config.turnTiming, mcpFunctionUrl: mcp.functionUrl });
    const simApi = new SimApiStack(this, 'sim-api', {
      ...common('sim-api'),
      stage: stageName,
      simApi: config.simApi,
      state: config.state,
      turnTiming: config.turnTiming,
      table: data.table,
      mcpFunctionUrl: mcp.functionUrl,
      runtimeArn: agent.runtimeArn,
      alarmTopic: foundation.alarmTopic,
      ...warmup,
    });
    // The simulator website (K1, #242), with sim-api behind it at /api.
    new WebStack(this, 'web', {
      ...common('web'),
      stage: stageName,
      siteDir,
      simApiUrl: simApi.functionUrl,
      originSecretParameter: config.simApi.originSecretParameter.replace('{stage}', stageName),
    });
    // The classic Alexa skill (#26): only with a skill ID, and only on the stages the config names.
    if (alexaSkillId !== undefined && config.alexa.stages.includes(stageName)) {
      new AlexaStack(this, 'alexa-skill', { ...common('alexa-skill'), stage: stageName, alexa: config.alexa, skillId: alexaSkillId, mcpFunctionUrl: mcp.functionUrl });
    }
  }
}

/** cdk-nag 3 AwsSolutions as a CDK validation plugin: any finding fails the synth. */
export function applyGuardrails(app: App): App {
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return app;
}

/**
 * `siteDir`: the built simulator (`pnpm --filter @cold-reserve/alexa-sim build:aws`), uploaded by each stage's web stack.
 * `alexaSkillId`: the classic skill's ID (#26), from the command line only; absent, no stage gets the skill function.
 */
export function buildApp(app: App, config: InfraConfig, siteDir: string, alexaSkillId?: string): App {
  for (const stage of config.stages) new ColdReserveStage(app, stage, config, siteDir, alexaSkillId);
  return applyGuardrails(app);
}
