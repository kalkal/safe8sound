import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { InfraConfigSchema, SimApiConfigSchema, SimApiStack, applyGuardrails, buildApp, loadInfraConfig, type SimApiConfig } from '../src/index.js';
import { SITE_DIR, exampleConfig } from './fixtures.js';

// Template assertions for the sim-api stack (#17): the demo API behind a Function URL. Bundling is skipped
// here (`aws:cdk:bundling-stacks: []`); `pnpm synth` bundles the Lambda for real.

const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/cold_reserve_dev_agent-AbCdEf1234';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:111122223333:table/ColdReserve-dev';

// The cdk.json values, with a simulator origin so the CORS rules are on.
const exampleSimApi = (): SimApiConfig => ({ ...exampleConfig().simApi, allowedOrigins: ['https://sim.example'] });

function synth(simApi: SimApiConfig = exampleSimApi()): Template {
  const app = applyGuardrails(new App({ context: { 'aws:cdk:bundling-stacks': [] } }));
  const stack = new SimApiStack(app, 'sim', {
    env: { region: 'us-east-1', account: '111122223333' },
    stage: 'dev',
    simApi,
    state: { connectTimeoutMs: 500, requestTimeoutMs: 1500, maxAttempts: 3 },
    table: { tableArn: TABLE_ARN, tableName: 'ColdReserve-dev' },
    mcpFunctionUrl: 'https://mcp.lambda-url.us-east-1.on.aws/',
    runtimeArn: RUNTIME_ARN,
  });
  app.synth(); // the cdk-nag checks run here: any finding fails the test
  return Template.fromStack(stack);
}

type Statement = { Action: string | string[]; Resource: unknown; Effect: string; Condition?: unknown };
const statementsOf = (t: Template): Statement[] =>
  Object.values(t.findResources('AWS::IAM::Policy')).flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement);
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

let t: Template;
beforeAll(() => {
  t = synth();
}, 90_000);

describe('sim-api stack (#17)', () => {
  it('runs on arm64 nodejs22.x with JSON logs, unreserved while the config sets no reserved concurrency', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      LoggingConfig: { LogFormat: 'JSON' },
      ReservedConcurrentExecutions: Match.absent(),
    });
  });

  it('takes the reserved concurrency of each stage from config when it is set', () => {
    synth({ ...exampleSimApi(), reservedConcurrency: { dev: 3, demo: 5 } }).hasResourceProperties('AWS::Lambda::Function', { ReservedConcurrentExecutions: 3 });
  });

  it('gets parameter names, the runtime ARN, the MCP URL, the caps and the table from config, never a secret value', () => {
    const env = t.findResources('AWS::Lambda::Function');
    const vars = (Object.values(env)[0] as { Properties: { Environment: { Variables: Record<string, unknown> } } }).Properties.Environment.Variables;
    expect(vars).toMatchObject({
      SIM_DEMO_CODES_PARAMETER: '/cold-reserve/dev/sim-api/demo-codes',
      SIM_TOKEN_KEYS_PARAMETER: '/cold-reserve/dev/sim-api/token-keys',
      SIM_MCP_TOKEN_PARAMETER: '/cold-reserve/dev/sim-api/mcp-token',
      SIM_ORIGIN_SECRET_PARAMETER: '/cold-reserve/dev/sim-api/origin-secret',
      SIM_ORIGIN_SECRET_PREVIOUS_PARAMETER: '/cold-reserve/dev/sim-api/origin-secret-previous',
      // sim-api's sandbox phone token (#267): read from SSM at start, never a value in the template.
      SIM_PHONE_TOKEN_PARAMETER: '/cold-reserve/dev/sim-api/phone-token',
      AGENT_RUNTIME_ARN: RUNTIME_ARN,
      SIM_MCP_URL: 'https://mcp.lambda-url.us-east-1.on.aws/mcp',
      SIM_AGENT_TIMEOUT_MS: '9000',
      SIM_MCP_TIMEOUT_MS: '3000',
      SSM_TIMEOUT_MS: '2000',
      SIM_ALLOWED_ORIGINS: 'https://sim.example',
      SIM_DEMO_ENABLED: 'true',
      SIM_TOKEN_TTL_S: '3600',
      SIM_LIMIT_TURNS_PER_CODE: '20',
      SIM_LIMIT_TURNS_GLOBAL: '30',
      SIM_LIMIT_TOOL_CALLS_PER_CODE: '20',
      SIM_LIMIT_CODE_ATTEMPTS_PER_IP_HOUR: '10',
      // The phone panel's caps (#294): per session and per demo code, from the CDK config.
      SIM_LIMIT_PHONE_READS_PER_SESSION_PER_MINUTE: '20',
      SIM_LIMIT_PHONE_READS_PER_CODE_PER_MINUTE: '120',
      STATE_TABLE_NAME: 'ColdReserve-dev',
      STATE_STORE_REQUEST_TIMEOUT_MS: '1500',
    });
    for (const secret of ['SIM_DEMO_CODES', 'SIM_TOKEN_KEYS', 'SIM_MCP_TOKEN']) expect(vars[secret]).toBeUndefined();
  });

  it('is reached through a Function URL with auth NONE (the handler checks the demo token) and NO CORS of its own (review of #156)', () => {
    // A Function URL with CORS adds its headers to every POST answer on top of the function's, so the
    // browser sees two Access-Control-Allow-Origin values and refuses the answer (Lambda docs, function URL
    // CORS). The handler answers CORS itself, exact origins only, OPTIONS included.
    t.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE', Cors: Match.absent() });
  });

  it('may invoke only the agent runtime of its stage (the runtime and its default endpoint)', () => {
    const invoke = statementsOf(t).filter((s) => actions(s).some((a) => a.startsWith('bedrock-agentcore:')));
    expect(invoke).toEqual([expect.objectContaining({ Action: 'bedrock-agentcore:InvokeAgentRuntime', Effect: 'Allow', Resource: [RUNTIME_ARN, `${RUNTIME_ARN}/runtime-endpoint/DEFAULT`] })]);
  });

  it('may only count quotas on the table: UpdateItem, and only on DEMO# keys', () => {
    const dynamo = statementsOf(t).filter((s) => actions(s).some((a) => a.startsWith('dynamodb:')));
    expect(dynamo).toEqual([
      expect.objectContaining({
        Action: 'dynamodb:UpdateItem',
        Resource: TABLE_ARN,
        Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['DEMO#*'] } },
      }),
    ]);
  });

  it('may read its SSM parameters (the origin secrets of #243 and the phone token of #267 included) and nothing else', () => {
    const ssm = statementsOf(t).filter((s) => actions(s).some((a) => a.startsWith('ssm:')));
    expect(ssm).toHaveLength(1);
    expect(ssm[0]?.Action).toBe('ssm:GetParameter');
    expect(JSON.stringify(ssm[0]?.Resource)).toMatch(/parameter\/cold-reserve\/dev\/sim-api\/demo-codes.*token-keys.*mcp-token.*origin-secret.*origin-secret-previous.*phone-token/);
  });

  it('has its own role with no managed policies, and keeps its logs 14 days', () => {
    t.hasResourceProperties('AWS::IAM::Role', { ManagedPolicyArns: Match.absent() });
    t.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });
  });

  it('alarms on any Lambda error and on the first log line of category "internal"', () => {
    t.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Errors', Threshold: 0 });
    t.hasResourceProperties('AWS::Logs::MetricFilter', { FilterPattern: '{ $.category = "internal" }', MetricTransformations: [Match.objectLike({ MetricName: 'InternalErrors', MetricNamespace: 'ColdReserve/dev' })] });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'InternalErrors', Threshold: 0 });
  });

  it('counts its internal errors under its own dimension, read from the log line, so the MCP server errors never fire its alarm (#275)', () => {
    t.hasResourceProperties('AWS::Logs::MetricFilter', { MetricTransformations: [Match.objectLike({ MetricName: 'InternalErrors', Dimensions: [{ Key: 'Component', Value: '$.component' }] })] });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'InternalErrors', Dimensions: [{ Name: 'Component', Value: 'sim-api' }] });
  });

  it('alarms on the p95 duration from config in 2 of 3 periods', () => {
    t.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Duration', ExtendedStatistic: 'p95', Threshold: 9000, EvaluationPeriods: 3, DatapointsToAlarm: 2 });
  });

  it('keeps the spoken replies in a private, encrypted, TLS-only bucket that forgets them after the configured days (F8d, #25)', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
      LifecycleConfiguration: { Rules: [Match.objectLike({ Prefix: 'speech/', ExpirationInDays: 30, Status: 'Enabled' })] },
    });
    t.hasResourceProperties('AWS::S3::BucketPolicy', { PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) } });
  });

  it('may call Polly SynthesizeSpeech only, and read and write only speech/ in its bucket', () => {
    const polly = statementsOf(t).filter((s) => actions(s).some((a) => a.startsWith('polly:')));
    expect(polly).toEqual([expect.objectContaining({ Action: 'polly:SynthesizeSpeech', Resource: '*' })]);
    const s3 = statementsOf(t).filter((s) => actions(s).some((a) => a.startsWith('s3:')));
    expect(s3.flatMap(actions).sort()).toEqual(['s3:GetObject', 's3:ListBucket', 's3:PutObject']);
    const objects = s3.filter((s) => !actions(s).includes('s3:ListBucket'));
    expect(JSON.stringify(objects.map((s) => s.Resource))).toContain('/speech/*"');
  });

  it('may list its bucket, only under speech/, so a missing object is a 404 miss and not a 403 (review of #195)', () => {
    const list = statementsOf(t).filter((s) => actions(s).includes('s3:ListBucket'));
    expect(list).toEqual([expect.objectContaining({ Action: 's3:ListBucket', Condition: { StringLike: { 's3:prefix': ['speech/*'] } } })]);
    expect(JSON.stringify(list[0]?.Resource)).not.toContain('/speech');
  });

  it('passes the speech settings of the stage, the bucket and the character caps', () => {
    const fn = Object.values(t.findResources('AWS::Lambda::Function'))[0] as { Properties: { Environment: { Variables: Record<string, unknown> } } };
    expect(fn.Properties.Environment.Variables).toMatchObject({
      SIM_SPEECH_ENABLED: 'false',
      SIM_SPEECH_ENGINE: 'neural',
      SIM_SPEECH_VOICE: 'Joanna',
      SIM_POLLY_TIMEOUT_MS: '2500',
      SIM_SPEECH_CACHE_TIMEOUT_MS: '1000',
      SIM_LIMIT_SPEECH_CHARS_PER_CODE: '6000',
      SIM_LIMIT_SPEECH_CHARS_GLOBAL: '30000',
    });
    expect(fn.Properties.Environment.Variables['SIM_SPEECH_BUCKET']).toEqual({ Ref: expect.stringMatching(/^SpeechCache/) as unknown });
  });

  it('outputs the sim-api URL', () => {
    expect(Object.keys(t.findOutputs('SimApiUrl'))).toEqual(['SimApiUrl']);
  });
});

describe('the sim-api time budget (Copilot on #156): the caller never gets a raw 502', () => {
  // Worst case of one request: the SSM reads at a cold start, two DynamoDB calls with every attempt, then
  // the agent (or the MCP server), plus a margin for the SDK backoff.
  const parse = (simApi: Partial<SimApiConfig>, state: Partial<ReturnType<typeof exampleConfig>['state']> = {}) =>
    InfraConfigSchema.safeParse({ ...exampleConfig(), simApi: { ...exampleConfig().simApi, ...simApi }, state: { ...exampleConfig().state, ...state } });

  it('accepts the cdk.json values: the turn needs 24 s; a spoken reply 2 s SSM + 2 x 1 s cache + 4 x 6 s DynamoDB + 2.5 s Polly + 1 s = 31.5 s, within 32 s', () => {
    expect(parse({}).success).toBe(true);
  });

  it('counts the spoken reply too (F8d part 3, #25): two counts and two refunds, the cache twice, Polly', () => {
    expect(parse({ timeoutSeconds: 31 }).success).toBe(false);
    expect(parse({ speech: { ...exampleConfig().simApi.speech, pollyTimeoutMs: 4000 } }).success).toBe(false);
  });

  it('refuses a function timeout that the worst case does not fit in, and names the setting', () => {
    const result = parse({ timeoutSeconds: 15 });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('timeoutSeconds');
    expect(parse({}, { maxAttempts: 5 }).success).toBe(false);
    expect(parse({ mcpTimeoutMs: 20_000, agentTimeoutMs: 3000 }).success).toBe(false);
  });
});

describe('SimApiConfigSchema', () => {
  it('accepts the example and refuses parameters outside the sim-api prefix', () => {
    expect(SimApiConfigSchema.safeParse(exampleSimApi()).success).toBe(true);
    expect(SimApiConfigSchema.safeParse({ ...exampleSimApi(), mcpTokenParameter: '/cold-reserve/{stage}/mcp-server/clients' }).success).toBe(false);
  });

  it('refuses an agent timeout that does not fit in the function timeout', () => {
    expect(SimApiConfigSchema.safeParse({ ...exampleSimApi(), timeoutSeconds: 20, agentTimeoutMs: 25_000 }).success).toBe(false);
  });

  it('refuses an origin with a path (CORS matches exact origins)', () => {
    expect(SimApiConfigSchema.safeParse({ ...exampleSimApi(), allowedOrigins: ['https://sim.example/app'] }).success).toBe(false);
  });
});

describe('the app wires the sim-api stack in every stage', () => {
  const app = buildApp(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), exampleConfig(), SITE_DIR);
  const stacks = app.node.findAll().filter((c): c is Stack => Stack.isStack(c));
  const sim = (stage: string) => {
    const stack = stacks.find((x) => x.stackName === `cold-reserve-${stage}-sim-api`);
    if (!stack) throw new Error(`No sim-api stack for ${stage}`);
    return Template.fromStack(stack);
  };

  it('in dev and demo, with the runtime ARN, the MCP URL and the table taken from the other stacks of the same stage', () => {
    for (const stage of ['dev', 'demo']) {
      const fn = Object.values(sim(stage).findResources('AWS::Lambda::Function'))[0] as { Properties: { Environment: { Variables: Record<string, unknown> } } };
      const vars = fn.Properties.Environment.Variables;
      expect(JSON.stringify(vars['AGENT_RUNTIME_ARN'])).toContain(`{"Fn::ImportValue":"cold-reserve-${stage}-agent:`);
      expect(JSON.stringify(vars['STATE_TABLE_NAME'])).toContain(`{"Fn::ImportValue":"cold-reserve-${stage}-data:`);
      expect(JSON.stringify(vars['SIM_MCP_URL'])).toContain(`cold-reserve-${stage}-mcp:`);
      expect(vars['SIM_DEMO_CODES_PARAMETER']).toBe(`/cold-reserve/${stage}/sim-api/demo-codes`);
    }
  });

  it('reads its section from the CDK context, and refuses a config without it', () => {
    const config = exampleConfig();
    const context = (simApi: unknown) => (key: string) =>
      ({ 'cold-reserve:region': config.region, 'cold-reserve:stages': config.stages, 'cold-reserve:mcp': config.mcp, 'cold-reserve:state': config.state, 'cold-reserve:agent': config.agent, 'cold-reserve:simApi': simApi })[key];
    expect(loadInfraConfig(context(config.simApi))).toEqual({ ok: true, value: config });
    expect(loadInfraConfig(context(undefined))).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});
