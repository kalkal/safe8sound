import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArnFormat, CfnOutput, Duration, Fn, RemovalPolicy, Stack, Validations, type StackProps } from 'aws-cdk-lib';
import { ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, FunctionUrlAuthType, LoggingFormat, ParamsAndSecretsLayerVersion, ParamsAndSecretsVersions, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { BlockPublicAccess, Bucket, BucketEncryption, type CfnBucket } from 'aws-cdk-lib/aws-s3';
import { FilterPattern, LogGroup, MetricFilter, type CfnLogGroup } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { simApiAgentTimeoutMs, type SimApiConfig, type StageName, type StateConfig, type TurnTiming } from './config.js';
import { addWarmup, type WarmupSchedule } from './warmup.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface SimApiStackProps extends StackProps {
  readonly stage: StageName;
  readonly simApi: SimApiConfig;
  readonly state: StateConfig;
  /** The one timing table of a turn (#270): how long sim-api waits for the agent. */
  readonly turnTiming: TurnTiming;
  /** Only what the function needs: the name for its env, the ARN for its policy. */
  readonly table: { readonly tableArn: string; readonly tableName: string };
  /** The MCP server's Function URL (ends with `/`), for the card actions. */
  readonly mcpFunctionUrl: string;
  /** The AgentCore runtime of the same stage: the only one this function may invoke. */
  readonly runtimeArn: string;
  /** The scheduled warm-up (#407): only while it is switched on for this stage. */
  readonly warmup?: WarmupSchedule;
}

/**
 * The sim-api Lambda (#17): the demo API the web simulator calls. arm64 nodejs22.x bundled from
 * apps/sim-api/src/lambda-main.ts, a Function URL with auth NONE (the handler checks the demo token and
 * answers CORS for the exact simulator origins), secrets from SSM through the Parameters and Secrets extension,
 * least-privilege IAM (one runtime, quota keys only), JSON logs, alarms on errors and p95.
 */
export class SimApiStack extends Stack {
  /** The Function URL, for the web stack's /api origin (K1, #242). */
  readonly functionUrl: string;

  constructor(scope: Construct, id: string, props: SimApiStackProps) {
    super(scope, id, props);
    const { stage, simApi, state, table } = props;
    const parameter = (name: string) => name.replace('{stage}', stage);
    const parameters = [simApi.demoCodesParameter, simApi.tokenKeysParameter, simApi.mcpTokenParameter, simApi.originSecretParameter, simApi.originSecretPreviousParameter, simApi.phoneTokenParameter].map(parameter);

    const logGroup = new LogGroup(this, 'Logs', { retention: simApi.logRetentionDays, removalPolicy: RemovalPolicy.DESTROY });
    // Own role instead of AWSLambdaBasicExecutionRole: logs only to this group.
    const role = new Role(this, 'Role', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
    logGroup.grantWrite(role);
    // Invoking needs both the runtime and the endpoint (Service Authorization Reference); no qualifier = DEFAULT.
    role.addToPolicy(new PolicyStatement({ actions: ['bedrock-agentcore:InvokeAgentRuntime'], resources: [props.runtimeArn, `${props.runtimeArn}/runtime-endpoint/DEFAULT`] }));

    // The studio voice (F8d, #25, approved in #25): the spoken replies already paid for, private, SSE-S3,
    // TLS only, forgotten after the configured days. Kept on demo (what the judges hear), dropped with dev.
    const speechCache = new Bucket(this, 'SpeechCache', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ prefix: 'speech/', expiration: Duration.days(simApi.speech.cacheDays) }],
      removalPolicy: stage === 'demo' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    role.addToPolicy(new PolicyStatement({ actions: ['s3:GetObject', 's3:PutObject'], resources: [speechCache.arnForObjects('speech/*')] }));
    // Without ListBucket, S3 answers a missing object with 403 AccessDenied instead of 404 NoSuchKey, so every
    // cache miss would look like a failure (review of #195). Listing is limited to the speech/ prefix.
    role.addToPolicy(new PolicyStatement({ actions: ['s3:ListBucket'], resources: [speechCache.bucketArn], conditions: { StringLike: { 's3:prefix': ['speech/*'] } } }));
    // SynthesizeSpeech has one optional resource type, a lexicon; we use none, so the resource is "*".
    role.addToPolicy(new PolicyStatement({ actions: ['polly:SynthesizeSpeech'], resources: ['*'] }));
    // The caps only (decided in #17): one atomic UpdateItem per use, on DEMO# keys and nothing else.
    role.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['DEMO#*'] } },
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: parameters.map((name) => this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: name.slice(1), arnFormat: ArnFormat.SLASH_RESOURCE_NAME })),
      }),
    );

    const fn = new NodejsFunction(this, 'Api', {
      entry: join(ROOT, 'apps', 'sim-api', 'src', 'lambda-main.ts'),
      handler: 'handler',
      projectRoot: ROOT,
      depsLockFilePath: join(ROOT, 'pnpm-lock.yaml'),
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      // JSON format: our JSON lines on stdout reach CloudWatch unchanged (review of #134).
      loggingFormat: LoggingFormat.JSON,
      memorySize: simApi.memoryMb,
      timeout: Duration.seconds(simApi.timeoutSeconds),
      role,
      logGroup,
      ...(simApi.reservedConcurrency === undefined ? {} : { reservedConcurrentExecutions: simApi.reservedConcurrency[stage] }),
      paramsAndSecrets: ParamsAndSecretsLayerVersion.fromVersion(ParamsAndSecretsVersions.V1_0_103),
      environment: {
        SIM_DEMO_CODES_PARAMETER: parameter(simApi.demoCodesParameter),
        SIM_TOKEN_KEYS_PARAMETER: parameter(simApi.tokenKeysParameter),
        SIM_MCP_TOKEN_PARAMETER: parameter(simApi.mcpTokenParameter),
        // Only requests that came through the web stack's distribution (#243).
        SIM_ORIGIN_SECRET_PARAMETER: parameter(simApi.originSecretParameter),
        SIM_ORIGIN_SECRET_PREVIOUS_PARAMETER: parameter(simApi.originSecretPreviousParameter),
        SIM_PHONE_TOKEN_PARAMETER: parameter(simApi.phoneTokenParameter),
        SSM_TIMEOUT_MS: String(simApi.ssmTimeoutMs),
        AGENT_RUNTIME_ARN: props.runtimeArn,
        SIM_AGENT_TIMEOUT_MS: String(simApiAgentTimeoutMs(props.turnTiming)),
        SIM_MCP_URL: Fn.join('', [props.mcpFunctionUrl, 'mcp']),
        SIM_MCP_TIMEOUT_MS: String(simApi.mcpTimeoutMs),
        SIM_ALLOWED_ORIGINS: simApi.allowedOrigins.join(','),
        SIM_DEMO_ENABLED: String(simApi.demoEnabled[stage]),
        SIM_TOKEN_TTL_S: String(simApi.tokenTtlS),
        SIM_LIMIT_TURNS_PER_CODE: String(simApi.limits.turnsPerCodePerDay),
        SIM_LIMIT_TURNS_GLOBAL: String(simApi.limits.turnsGlobalPerDay),
        SIM_LIMIT_TOOL_CALLS_PER_CODE: String(simApi.limits.toolCallsPerCodePerDay),
        SIM_LIMIT_READ_CALLS_PER_CODE: String(simApi.limits.readCallsPerCodePerDay),
        SIM_LIMIT_READ_CALLS_GLOBAL: String(simApi.limits.readCallsGlobalPerDay),
        SIM_LIMIT_DEMO_CALLS_PER_CODE: String(simApi.limits.demoCallsPerCodePerDay),
        SIM_LIMIT_CODE_ATTEMPTS_PER_IP_HOUR: String(simApi.limits.codeAttemptsPerIpPerHour),
        SIM_LIMIT_SPEECH_CHARS_PER_CODE: String(simApi.limits.speechCharsPerCodePerDay),
        SIM_LIMIT_SPEECH_CHARS_GLOBAL: String(simApi.limits.speechCharsGlobalPerDay),
        SIM_LIMIT_PHONE_READS_PER_SESSION_PER_MINUTE: String(simApi.limits.phoneReadsPerSessionPerMinute),
        SIM_LIMIT_PHONE_READS_PER_CODE_PER_MINUTE: String(simApi.limits.phoneReadsPerCodePerMinute),
        SIM_LIMIT_LOG_LINES_PER_SESSION_PER_MINUTE: String(simApi.limits.logLinesPerSessionPerMinute),
        SIM_LIMIT_LOG_LINES_GLOBAL_PER_MINUTE: String(simApi.limits.logLinesGlobalPerMinute),
        SIM_SPEECH_ENABLED: String(simApi.speech.enabled[stage]),
        SIM_SPEECH_ENGINE: simApi.speech.engine,
        SIM_SPEECH_VOICE: simApi.speech.voice,
        SIM_SPEECH_BUCKET: speechCache.bucketName,
        SIM_POLLY_TIMEOUT_MS: String(simApi.speech.pollyTimeoutMs),
        SIM_SPEECH_CACHE_TIMEOUT_MS: String(simApi.speech.cacheTimeoutMs),
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
        // Bundle the AWS SDK clients too: the runtime's built-in SDK is not pinned and may lack the
        // AgentCore client; we ship the exact versions the tests ran with.
        externalModules: [],
        // Some dependencies still call require() on Node built-ins inside the ESM bundle.
        banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });

    // No CORS on the URL itself (review of #156): for POST, Lambda would send the URL's CORS headers AND the
    // function's, and the browser refuses two Access-Control-Allow-Origin values. The handler answers CORS,
    // OPTIONS included, for the exact origins in SIM_ALLOWED_ORIGINS.
    const url = fn.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });
    new CfnOutput(this, 'SimApiUrl', { value: url.url });
    this.functionUrl = url.url;
    if (props.warmup !== undefined) addWarmup(this, fn, props.warmup);

    fn.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }).createAlarm(this, 'Errors', {
      alarmDescription: 'The sim-api Lambda failed at least once in 5 minutes.',
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    fn.metricDuration({ period: Duration.minutes(5), statistic: 'p95' }).createAlarm(this, 'DurationP95', {
      alarmDescription: `The sim-api Lambda p95 duration is over ${String(simApi.p95AlarmMs)} ms.`,
      threshold: simApi.p95AlarmMs,
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
      // A dimension value is a log field, never a constant (#275): every sim-api line carries component "sim-api".
      // Without a dimension this metric would be the MCP server's, and each alarm would fire on the other's errors.
      dimensions: { Component: '$.component' },
    })
      .metric({ period: Duration.minutes(5), statistic: 'Sum', dimensionsMap: { Component: 'sim-api' } })
      .createAlarm(this, 'InternalErrors', {
        alarmDescription: 'The sim-api logged an error of category "internal" (a bug or a broken configuration).',
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });

    // cdk-nag 3 findings are acknowledged through CDK Validations, each with its reason.
    const logGroupId = this.getLogicalId(logGroup.node.defaultChild as CfnLogGroup);
    Validations.of(role).acknowledge(
      {
        id: `AwsSolutions-IAM5[Resource::<${logGroupId}.Arn>:*]`,
        reason: "Log streams are created at runtime: the grant is scoped to this function's own log group (log-group:<name>:*).",
      },
      {
        id: `AwsSolutions-IAM5[Resource::<${this.getLogicalId(speechCache.node.defaultChild as CfnBucket)}.Arn>/speech/*]`,
        reason: 'The spoken replies are named by the sha256 of engine, voice and text at runtime: Get/Put only, on the speech/ prefix of this stack’s own bucket.',
      },
      {
        id: 'AwsSolutions-IAM5[Resource::*]',
        reason:
          'polly:SynthesizeSpeech has a single optional resource type, a custom lexicon, and we use none, so the resource is "*" (https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonpolly.html). Only that one action is granted.',
      },
    );
    Validations.of(speechCache).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'A cache of spoken reply audio (no personal data, objects expire after cacheDays): every request already gets a JSON log line from the sim-api, so S3 access logs would only add cost.',
    });
    Validations.of(fn).acknowledge({
      id: 'AwsSolutions-L1',
      reason: 'Node 22 is the runtime decided for the project (plan §2, spike S1), supported until 2027-04-30.',
    });
  }
}
