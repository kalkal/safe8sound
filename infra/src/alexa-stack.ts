// The Lambda permission for the Alexa Skills Kit trigger (principal alexa-appkit.amazon.com with the skill ID as
// EventSourceToken) follows the design of KayLerch/alexa-skill-mcp-bridge (Apache-2.0, see NOTICE).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArnFormat, CfnOutput, Duration, Fn, RemovalPolicy, Stack, Validations, type StackProps } from 'aws-cdk-lib';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, LoggingFormat, ParamsAndSecretsLayerVersion, ParamsAndSecretsVersions, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, type CfnLogGroup } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { AlexaConfig, StageName } from './config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface AlexaStackProps extends StackProps {
  readonly stage: StageName;
  readonly alexa: AlexaConfig;
  /** The skill this function serves: given at deploy time only, never committed. */
  readonly skillId: string;
  /** The MCP server's Function URL (ends with `/`). */
  readonly mcpFunctionUrl: string;
}

/**
 * The classic Alexa skill bridge (#26): arm64 nodejs22.x bundled from apps/alexa-skill/src/lambda-main.ts, invoked
 * only by the Alexa Skills Kit for one skill ID, its MCP token from SSM through the Parameters and Secrets extension,
 * no model and no other AWS service. Logs only to its own 14-day group.
 */
export class AlexaStack extends Stack {
  readonly functionArn: string;

  constructor(scope: Construct, id: string, props: AlexaStackProps) {
    super(scope, id, props);
    const { stage, alexa, skillId } = props;
    const tokenParameter = alexa.tokenParameter.replace('{stage}', stage);

    const logGroup = new LogGroup(this, 'Logs', { retention: alexa.logRetentionDays, removalPolicy: RemovalPolicy.DESTROY });
    // Own role instead of AWSLambdaBasicExecutionRole: logs only to this group, one SSM parameter.
    const role = new Role(this, 'Role', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
    logGroup.grantWrite(role);
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: tokenParameter.slice(1), arnFormat: ArnFormat.SLASH_RESOURCE_NAME })],
      }),
    );

    const fn = new NodejsFunction(this, 'Skill', {
      functionName: `cold-reserve-${stage}-alexa-skill`,
      entry: join(ROOT, 'apps', 'alexa-skill', 'src', 'lambda-main.ts'),
      handler: 'handler',
      projectRoot: ROOT,
      depsLockFilePath: join(ROOT, 'pnpm-lock.yaml'),
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      loggingFormat: LoggingFormat.JSON,
      memorySize: alexa.memoryMb,
      timeout: Duration.seconds(alexa.timeoutSeconds),
      role,
      logGroup,
      ...(alexa.reservedConcurrency === undefined ? {} : { reservedConcurrentExecutions: alexa.reservedConcurrency }),
      paramsAndSecrets: ParamsAndSecretsLayerVersion.fromVersion(ParamsAndSecretsVersions.V1_0_103),
      environment: {
        ALEXA_SKILL_ID: skillId,
        ALEXA_MCP_URL: Fn.join('', [props.mcpFunctionUrl, 'mcp']),
        ALEXA_MCP_TOKEN_PARAMETER: tokenParameter,
        ALEXA_DEADLINE_MS: String(alexa.deadlineMs),
        ALEXA_SSM_TIMEOUT_MS: String(alexa.ssmTimeoutMs),
        ALEXA_MCP_TIMEOUT_MS: String(alexa.mcpTimeoutMs),
        ALEXA_TEMP_UNIT: alexa.tempUnit,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        minify: true,
        sourceMap: true,
        // Some dependencies still call require() on Node built-ins inside the ESM bundle.
        banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });

    // First of the two skill-ID checks: only the Alexa Skills Kit, and only for this skill, may invoke the function.
    fn.addPermission('AlexaSkillsKit', {
      principal: new ServicePrincipal('alexa-appkit.amazon.com'),
      action: 'lambda:InvokeFunction',
      eventSourceToken: skillId,
    });

    this.functionArn = fn.functionArn;
    new CfnOutput(this, 'AlexaSkillFunctionArn', { value: fn.functionArn, description: 'The endpoint to paste in the Alexa developer console (Build > Endpoint).' });

    const logGroupId = this.getLogicalId(logGroup.node.defaultChild as CfnLogGroup);
    Validations.of(role).acknowledge({
      id: `AwsSolutions-IAM5[Resource::<${logGroupId}.Arn>:*]`,
      reason: "Log streams are created at runtime: the grant is scoped to this function's own log group (log-group:<name>:*).",
    });
    Validations.of(fn).acknowledge({
      id: 'AwsSolutions-L1',
      reason: 'Node 22 is the runtime decided for the project (plan §2, spike S1), supported until 2027-04-30.',
    });
  }
}
