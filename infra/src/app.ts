import { CfnWaitConditionHandle, Stack, Stage, Validations, type App, type StackProps } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { Construct } from 'constructs';
import type { InfraConfig, StageName } from './config.js';
import { AgentStack } from './agent-stack.js';
import { DataStack } from './data-stack.js';
import { McpStack } from './mcp-stack.js';
import { SimApiStack } from './sim-api-stack.js';
import { WebStack } from './web-stack.js';

/** Placeholder for the shared resources (the web, agent and data stacks have their own). */
export class FoundationStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    // CloudFormation rejects a stack without resources; this no-cost handle keeps it deployable
    // until the first real resource lands.
    new CfnWaitConditionHandle(this, 'Placeholder');
  }
}

export class ColdReserveStage extends Stage {
  constructor(scope: Construct, stageName: StageName, config: InfraConfig, siteDir: string) {
    super(scope, stageName, { env: { region: config.region } });
    const common = (name: string) => ({
      stackName: `cold-reserve-${stageName}-${name}`,
      // demo is what the judges see: deploys are manual and reserved to the owner.
      terminationProtection: stageName === 'demo',
      tags: { project: 'cold-reserve', stage: stageName },
    });
    new FoundationStack(this, 'foundation', common('foundation'));
    const data = new DataStack(this, 'data', { ...common('data'), retain: stageName === 'demo' });
    const mcp = new McpStack(this, 'mcp', { ...common('mcp'), stage: stageName, mcp: config.mcp, state: config.state, table: data.table });
    const agent = new AgentStack(this, 'agent', { ...common('agent'), stage: stageName, agent: config.agent, mcpFunctionUrl: mcp.functionUrl });
    const simApi = new SimApiStack(this, 'sim-api', {
      ...common('sim-api'),
      stage: stageName,
      simApi: config.simApi,
      state: config.state,
      table: data.table,
      mcpFunctionUrl: mcp.functionUrl,
      runtimeArn: agent.runtimeArn,
    });
    // The simulator website (K1, #242), with sim-api behind it at /api.
    new WebStack(this, 'web', {
      ...common('web'),
      stage: stageName,
      siteDir,
      simApiUrl: simApi.functionUrl,
      originSecretParameter: config.simApi.originSecretParameter.replace('{stage}', stageName),
    });
  }
}

/** cdk-nag 3 AwsSolutions as a CDK validation plugin: any finding fails the synth. */
export function applyGuardrails(app: App): App {
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return app;
}

/** `siteDir`: the built simulator (`pnpm --filter @cold-reserve/alexa-sim build:aws`), uploaded by each stage's web stack. */
export function buildApp(app: App, config: InfraConfig, siteDir: string): App {
  for (const stage of config.stages) new ColdReserveStage(app, stage, config, siteDir);
  return applyGuardrails(app);
}
