import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArnFormat, CfnOutput, DockerImage, Fn, Stack, Validations, type StackProps } from 'aws-cdk-lib';
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import type { Construct } from 'constructs';
import type { AgentConfig, StageName, TurnTiming } from './config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT = join(ROOT, 'apps', 'agent');

export interface AgentStackProps extends StackProps {
  readonly stage: StageName;
  readonly agent: AgentConfig;
  /** The one timing table of a turn (#270): the agent's deadline. */
  readonly turnTiming: TurnTiming;
  /** The MCP server's Function URL (ends with `/`); the server answers on `/mcp`. */
  readonly mcpFunctionUrl: string;
}

/**
 * The agent on AgentCore Runtime (#17, G1b; decisions in docs/agentcore.md):
 * - direct code deployment of the one-file CommonJS bundle (Node 22, `app.js`), built at synth time;
 * - HTTP protocol, public network, no authorizer: callers are authenticated by IAM (SigV4) through
 *   InvokeAgentRuntime, and only sim-api's role gets that permission (G1c);
 * - idle sessions end after `idleRuntimeSessionTimeoutSeconds` (900 in infra/cdk.json);
 * - its own role: Bedrock on the configured model only, its MCP token parameter only, its own logs.
 */
export class AgentStack extends Stack {
  readonly runtimeArn: string;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);
    const { stage, agent } = props;
    const runtimeName = `cold_reserve_${stage}_agent`;
    const tokenParameter = agent.mcpTokenParameter.replace('{stage}', stage);

    // The bundle is built into the asset folder at synth time (scripts/bundle.ts --out); tests skip it.
    const code = new Asset(this, 'Code', {
      path: AGENT,
      exclude: ['node_modules', 'dist', 'test', 'coverage'],
      bundling: {
        image: DockerImage.fromRegistry('public.ecr.aws/docker/library/node:22'),
        local: {
          tryBundle(outputDir: string) {
            execFileSync(process.execPath, ['--import', 'tsx', 'scripts/bundle.ts', '--out', outputDir], { cwd: AGENT, stdio: 'inherit' });
            return true;
          },
        },
      },
    });

    const role = new Role(this, 'Role', {
      assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': this.formatArn({ service: 'bedrock-agentcore', resource: '*' }) },
        },
      }),
      description: `The ${stage} agent on AgentCore Runtime: Bedrock, its MCP token, its logs.`,
    });
    role.addToPolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          this.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: agent.modelId, arnFormat: ArnFormat.SLASH_RESOURCE_NAME }),
          // A geo inference profile routes to the model in several regions of its geography.
          this.formatArn({ service: 'bedrock', region: '*', account: '', resource: 'foundation-model', resourceName: agent.foundationModelId, arnFormat: ArnFormat.SLASH_RESOURCE_NAME }),
        ],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: tokenParameter.slice(1), arnFormat: ArnFormat.SLASH_RESOURCE_NAME })],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
        resources: [this.formatArn({ service: 'logs', resource: 'log-group', resourceName: '/aws/bedrock-agentcore/runtimes/*', arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      }),
    );
    // As the AWS execution role template for a runtime does (runtime-permissions.html): a resource policy on
    // this runtime's own log groups, and listing the groups. X-Ray and cloudwatch:PutMetricData stay out
    // (only ADOT needs them).
    role.addToPolicy(
      new PolicyStatement({
        actions: ['logs:PutResourcePolicy'],
        resources: [this.formatArn({ service: 'logs', resource: 'log-group', resourceName: `/aws/bedrock-agentcore/runtimes/${runtimeName}-*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      }),
    );
    role.addToPolicy(new PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: [this.formatArn({ service: 'logs', resource: 'log-group', resourceName: '*', arnFormat: ArnFormat.COLON_RESOURCE_NAME })] }));
    // The code zip only, by its exact key: no bucket-wide or wildcard S3 actions.
    role.addToPolicy(new PolicyStatement({ actions: ['s3:GetObject'], resources: [code.bucket.arnForObjects(code.s3ObjectKey)] }));

    // cdk-nag 3 findings are acknowledged through CDK Validations, each with its reason.
    Validations.of(role).acknowledge(
      {
        id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:bedrock:*::foundation-model/${agent.foundationModelId}]`,
        reason: 'A geo inference profile (us.*) routes to the same model in several US regions; the profile ARN itself is exact.',
      },
      {
        id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:${this.region}:<AWS::AccountId>:log-group:/aws/bedrock-agentcore/runtimes/*]`,
        reason: 'AgentCore names the runtime log groups (/aws/bedrock-agentcore/runtimes/<runtime-id>-<endpoint>) after creation.',
      },
      {
        id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:${this.region}:<AWS::AccountId>:log-group:/aws/bedrock-agentcore/runtimes/${runtimeName}-*]`,
        reason:
          "PutResourcePolicy on this runtime's own log groups only, whose suffix AgentCore picks; as in the AWS execution role template (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html).",
      },
      {
        id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:${this.region}:<AWS::AccountId>:log-group:*]`,
        reason:
          'DescribeLogGroups cannot be scoped to one group (it lists them); read-only, and as in the AWS execution role template (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html).',
      },
    );

    const runtime = new CfnRuntime(this, 'Runtime', {
      agentRuntimeName: runtimeName,
      description: `The ${stage} voice agent: Strands with Bedrock, the MCP server as its only tool source.`,
      agentRuntimeArtifact: {
        codeConfiguration: { code: { s3: { bucket: code.s3BucketName, prefix: code.s3ObjectKey } }, entryPoint: ['app.js'], runtime: 'NODE_22' },
      },
      roleArn: role.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      lifecycleConfiguration: { idleRuntimeSessionTimeout: agent.idleRuntimeSessionTimeoutSeconds },
      environmentVariables: {
        AGENT_MODEL_PROVIDER: 'bedrock',
        AGENT_MODEL_ID: agent.modelId,
        AGENT_REGION: this.region,
        AGENT_MCP_URL: Fn.join('', [props.mcpFunctionUrl, 'mcp']),
        AGENT_MCP_TOKEN_PARAMETER: tokenParameter,
        AGENT_TURN_DEADLINE_MS: String(props.turnTiming.agentDeadlineMs),
      },
    });
    // The role and its policy exist before the runtime starts with them.
    runtime.node.addDependency(role);
    this.runtimeArn = runtime.attrAgentRuntimeArn;
    new CfnOutput(this, 'RuntimeArn', { value: runtime.attrAgentRuntimeArn });
  }
}
