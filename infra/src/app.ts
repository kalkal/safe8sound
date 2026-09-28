import { CfnWaitConditionHandle, Stack, Stage, Validations, type App, type StackProps } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { Construct } from 'constructs';
import type { InfraConfig, StageName } from './config.js';

/** Placeholder for the shared resources; F3/F5/F8 add the web, mcp, agent and data stacks. */
export class FoundationStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    // CloudFormation rejects a stack without resources; this no-cost handle keeps it deployable
    // until the first real resource lands.
    new CfnWaitConditionHandle(this, 'Placeholder');
  }
}

export class ColdReserveStage extends Stage {
  constructor(scope: Construct, stageName: StageName, config: InfraConfig) {
    super(scope, stageName, { env: { region: config.region } });
    new FoundationStack(this, 'foundation', {
      stackName: `cold-reserve-${stageName}-foundation`,
      // demo is what the judges see: deploys are manual and reserved to the owner.
      terminationProtection: stageName === 'demo',
      tags: { project: 'cold-reserve', stage: stageName },
    });
  }
}

/** cdk-nag 3 AwsSolutions as a CDK validation plugin: any finding fails the synth. */
export function applyGuardrails(app: App): App {
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return app;
}

export function buildApp(app: App, config: InfraConfig): App {
  for (const stage of config.stages) new ColdReserveStage(app, stage, config);
  return applyGuardrails(app);
}
