import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp, loadInfraConfig, type InfraConfig } from '../src/index.js';
import { exampleConfig } from './fixtures.js';

// Template assertions for the data and mcp stacks (issue #70). Bundling is skipped here
// (`aws:cdk:bundling-stacks: []`); `pnpm synth` bundles the Lambda for real.
const config: InfraConfig = exampleConfig();
let templates: Record<string, Template>;

const synthApp = (cfg: InfraConfig) => buildApp(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), cfg);
const templatesOf = (app: App) =>
  Object.fromEntries(
    app.node
      .findAll()
      .filter((c): c is Stack => Stack.isStack(c))
      .map((s) => [s.stackName, Template.fromStack(s)]),
  );

beforeAll(() => {
  templates = templatesOf(synthApp(config));
}, 90_000);

const tpl = (name: string) => {
  const t = templates[name];
  if (!t) throw new Error(`No stack ${name}`);
  return t;
};

type Statement = { Action: string | string[]; Resource: unknown; Effect: string };
const statementsOf = (t: Template): Statement[] =>
  Object.values(t.findResources('AWS::IAM::Policy')).flatMap(
    (p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement,
  );
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const resources = (s: Statement): unknown[] => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]);

/** The export the data stack gives for the table ARN, as the mcp stack imports it. */
function tableArnImport(stage: string): unknown {
  const outputs = tpl(`cold-reserve-${stage}-data`).findOutputs('*') as Record<string, { Value: unknown; Export?: { Name: string } }>;
  const arn = Object.values(outputs).find((o) => JSON.stringify(o.Value).includes('"Arn"'));
  if (!arn?.Export) throw new Error('The data stack exports no table ARN');
  return { 'Fn::ImportValue': arn.Export.Name };
}

describe('data stack: the single state table', () => {
  it('is on-demand with PK/SK strings, TTL attribute ttl, PITR on and no GSI', () => {
    const t = tpl('cold-reserve-dev-data');
    t.resourceCountIs('AWS::DynamoDB::Table', 1);
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      GlobalSecondaryIndexes: Match.absent(),
    });
  });

  it('is retained and deletion-protected on demo only', () => {
    tpl('cold-reserve-demo-data').hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({ DeletionProtectionEnabled: true }),
    });
    tpl('cold-reserve-dev-data').hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ DeletionProtectionEnabled: false }),
    });
  });
});

describe('mcp stack: the MCP server Lambda', () => {
  it('runs on arm64 nodejs22.x, unreserved while cdk.json sets no reserved concurrency', () => {
    tpl('cold-reserve-dev-mcp').hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      ReservedConcurrentExecutions: Match.absent(),
    });
  });

  it('takes the reserved concurrency of each stage from config when it is set', () => {
    const reserved = templatesOf(synthApp({ ...config, mcp: { ...config.mcp, reservedConcurrency: { dev: 3, demo: 5 } } }));
    const dev = reserved['cold-reserve-dev-mcp'];
    const demo = reserved['cold-reserve-demo-mcp'];
    if (!dev || !demo) throw new Error('mcp stacks missing');
    dev.hasResourceProperties('AWS::Lambda::Function', { ReservedConcurrentExecutions: 3 });
    demo.hasResourceProperties('AWS::Lambda::Function', { ReservedConcurrentExecutions: 5 });
  });

  it('gets parameter names, the table name and the SDK timeouts from config, never token values', () => {
    const t = tpl('cold-reserve-dev-mcp');
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          MCP_CLIENTS_PARAMETER: '/cold-reserve/dev/mcp-server/clients',
          SSM_TIMEOUT_MS: '2000',
          STATE_TABLE_NAME: Match.anyValue(),
          STATE_STORE_CONNECT_TIMEOUT_MS: '500',
          STATE_STORE_REQUEST_TIMEOUT_MS: '1500',
          STATE_STORE_MAX_ATTEMPTS: '3',
          MCP_SCENARIO: 'clear-day',
          // R1: every container anchors the scenario on the UTC day, never on its own start.
          MCP_SCENARIO_ANCHOR: 'daily',
          // #149: the Function URL cannot go into its own Lambda's env (a circular dependency in CloudFormation),
          // so the server takes its canonical URL from each request.
          MCP_RESOURCE_URL: 'auto',
        }),
      },
    });
    expect(JSON.stringify(t.toJSON())).not.toMatch(/MCP_CLIENTS"\s*:/);
  });

  it('is reached through a Function URL with auth NONE (the handler checks the bearer token)', () => {
    tpl('cold-reserve-dev-mcp').hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
  });

  it('has its own role, no managed policies, and IAM limited to the table and the SSM parameter', () => {
    const t = tpl('cold-reserve-dev-mcp');
    t.hasResourceProperties('AWS::IAM::Role', { ManagedPolicyArns: Match.absent() });
    const statements = statementsOf(t);
    const dynamo = statements.filter((s) => actions(s).some((a) => a.startsWith('dynamodb:')));
    expect(dynamo.flatMap(actions).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem']);
    for (const s of dynamo) {
      expect(actions(s).some((a) => a.includes('*'))).toBe(false);
      expect(s.Resource).toEqual(tableArnImport('dev'));
    }
    const ssm = statements.filter((s) => actions(s).some((a) => a.startsWith('ssm:')));
    expect(ssm.flatMap(actions)).toEqual(['ssm:GetParameter']);
    expect(JSON.stringify(ssm[0]?.Resource)).toContain(':parameter/cold-reserve/dev/mcp-server/clients');
    // No statement grants a bare "*" resource, alone or inside an array.
    expect(statements.flatMap(resources)).not.toContain('*');
  });

  it('keeps its logs 14 days', () => {
    tpl('cold-reserve-dev-mcp').hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });
  });

  it('alarms on any error and on p95 duration over 500 ms in 2 of 3 periods (one cold start does not fire it)', () => {
    const t = tpl('cold-reserve-dev-mcp');
    t.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Statistic: 'Sum',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
    });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Duration',
      ExtendedStatistic: 'p95',
      Threshold: 500,
      EvaluationPeriods: 3,
      DatapointsToAlarm: 2,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  it('logs in JSON format, so our JSON lines on stdout reach CloudWatch as they are (review of #134)', () => {
    tpl('cold-reserve-dev-mcp').hasResourceProperties('AWS::Lambda::Function', { LoggingConfig: Match.objectLike({ LogFormat: 'JSON' }) });
  });

  it('counts log lines of category "internal" and alarms on the first one (#112)', () => {
    const t = tpl('cold-reserve-dev-mcp');
    t.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '{ $.category = "internal" }',
      MetricTransformations: [Match.objectLike({ MetricNamespace: 'ColdReserve/dev', MetricName: 'InternalErrors', MetricValue: '1' })],
    });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'InternalErrors',
      Namespace: 'ColdReserve/dev',
      Statistic: 'Sum',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
    });
  });
});

describe('loadInfraConfig for the mcp and state settings', () => {
  const context = (overrides: Record<string, unknown> = {}) => {
    const values: Record<string, unknown> = {
      'cold-reserve:region': config.region,
      'cold-reserve:stages': config.stages,
      'cold-reserve:mcp': config.mcp,
      'cold-reserve:state': config.state,
      'cold-reserve:agent': config.agent,
      ...overrides,
    };
    return (key: string) => values[key];
  };

  it('reads them from the CDK context', () => {
    expect(loadInfraConfig(context())).toEqual({ ok: true, value: config });
  });

  it('accepts a fixed ISO instant as the scenario anchor (a recording session)', () => {
    const mcp = { ...config.mcp, scenarioAnchor: '2026-10-20T08:00:00+02:00' };
    expect(loadInfraConfig(context({ 'cold-reserve:mcp': mcp }))).toEqual({ ok: true, value: { ...config, mcp } });
  });

  it.each([
    ['a zero reserved concurrency', { ...config.mcp, reservedConcurrency: { dev: 0, demo: 5 } }],
    ['a parameter name without {stage}', { ...config.mcp, clientsParameter: '/cold-reserve/mcp-server/clients' }],
    ['a parameter name outside the per-function /mcp-server/ prefix', { ...config.mcp, clientsParameter: '/cold-reserve/{stage}/mcp-clients' }],
    ['a missing log retention', { ...config.mcp, logRetentionDays: undefined }],
    ['a log retention CloudWatch does not offer', { ...config.mcp, logRetentionDays: 15 }],
    ['a scenario anchor on the container start (R1)', { ...config.mcp, scenarioAnchor: 'start' }],
    ['a missing scenario anchor', { ...config.mcp, scenarioAnchor: undefined }],
  ])('rejects %s with invalid_config', (_name, mcp) => {
    expect(loadInfraConfig(context({ 'cold-reserve:mcp': mcp }))).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});
