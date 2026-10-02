import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, Validations, type StackProps } from 'aws-cdk-lib';
import { ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, FunctionUrlAuthType, LoggingFormat, ParamsAndSecretsLayerVersion, ParamsAndSecretsVersions, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { FilterPattern, LogGroup, MetricFilter, type CfnLogGroup } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { McpConfig, StageName, StateConfig } from './config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface McpStackProps extends StackProps {
  readonly stage: StageName;
  readonly mcp: McpConfig;
  readonly state: StateConfig;
  /** Only what the function needs: the name for its env, the ARN for its policy. */
  readonly table: { readonly tableArn: string; readonly tableName: string };
}

/**
 * The MCP server Lambda (issue #70): arm64 nodejs22.x bundled from apps/mcp-server/src/lambda-main.ts,
 * a Function URL with auth NONE (the handler checks the bearer token), tokens from SSM through the
 * Parameters and Secrets extension, least-privilege IAM, 14-day logs, alarms on errors and p95.
 */
export class McpStack extends Stack {
  /** The Function URL (ends with `/`): the agent reaches the server at `<url>mcp`. */
  readonly functionUrl: string;

  constructor(scope: Construct, id: string, props: McpStackProps) {
    super(scope, id, props);
    const { stage, mcp, state, table } = props;
    const clientsParameter = mcp.clientsParameter.replace('{stage}', stage);

    const logGroup = new LogGroup(this, 'Logs', {
      retention: mcp.logRetentionDays,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // Own role instead of AWSLambdaBasicExecutionRole: logs only to this group.
    const role = new Role(this, 'Role', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
    logGroup.grantWrite(role);
    role.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
        resources: [table.tableArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: clientsParameter.slice(1), arnFormat: ArnFormat.SLASH_RESOURCE_NAME })],
      }),
    );

    const fn = new NodejsFunction(this, 'Server', {
      entry: join(ROOT, 'apps', 'mcp-server', 'src', 'lambda-main.ts'),
      handler: 'handler',
      projectRoot: ROOT,
      depsLockFilePath: join(ROOT, 'pnpm-lock.yaml'),
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      // JSON format: our JSON lines on stdout reach CloudWatch unchanged (review of #134).
      loggingFormat: LoggingFormat.JSON,
      memorySize: mcp.memoryMb,
      timeout: Duration.seconds(mcp.timeoutSeconds),
      role,
      logGroup,
      ...(mcp.reservedConcurrency === undefined ? {} : { reservedConcurrentExecutions: mcp.reservedConcurrency[stage] }),
      paramsAndSecrets: ParamsAndSecretsLayerVersion.fromVersion(ParamsAndSecretsVersions.V1_0_103),
      environment: {
        MCP_CLIENTS_PARAMETER: clientsParameter,
        SSM_TIMEOUT_MS: String(mcp.ssmTimeoutMs),
        MCP_ALLOWED_ORIGINS: mcp.allowedOrigins.join(','),
        MCP_SCENARIO: mcp.scenario,
        MCP_SCENARIO_ANCHOR: mcp.scenarioAnchor,
        // #149: the Function URL cannot go into its own Lambda's env (a circular dependency), so the server takes
        // its canonical URL from each request: the Function URL domain AWS puts in the event.
        MCP_RESOURCE_URL: 'auto',
        STATE_TABLE_NAME: table.tableName,
        STATE_STORE_CONNECT_TIMEOUT_MS: String(state.connectTimeoutMs),
        STATE_STORE_REQUEST_TIMEOUT_MS: String(state.requestTimeoutMs),
        STATE_STORE_MAX_ATTEMPTS: String(state.maxAttempts),
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

    const url = fn.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });
    new CfnOutput(this, 'McpUrl', { value: url.url });
    this.functionUrl = url.url;

    fn.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }).createAlarm(this, 'Errors', {
      alarmDescription: 'The MCP server Lambda failed at least once in 5 minutes.',
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    fn.metricDuration({ period: Duration.minutes(5), statistic: 'p95' }).createAlarm(this, 'DurationP95', {
      alarmDescription: `The MCP server Lambda p95 duration is over ${String(mcp.p95AlarmMs)} ms (plan §1 principle 9).`,
      threshold: mcp.p95AlarmMs,
      // 2 of 3 five-minute periods: a single cold start does not fire it.
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    // Handled errors never fail the invocation, so Errors misses them: count our own log lines of
    // category "internal" (a bug or a broken config, docs/error-handling.md) and alarm on the first one.
    new MetricFilter(this, 'InternalErrorsFilter', {
      logGroup,
      filterPattern: FilterPattern.stringValue('$.category', '=', 'internal'),
      metricNamespace: `ColdReserve/${stage}`,
      metricName: 'InternalErrors',
      metricValue: '1',
    })
      .metric({ period: Duration.minutes(5), statistic: 'Sum' })
      .createAlarm(this, 'InternalErrors', {
        alarmDescription: 'The MCP server logged an error of category "internal" (a bug or a broken configuration).',
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });

    // cdk-nag 3 findings are acknowledged through CDK Validations, each with its reason.
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
