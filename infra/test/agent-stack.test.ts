import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp, loadInfraConfig, type InfraConfig } from '../src/index.js';
import { SITE_DIR, exampleConfig } from './fixtures.js';

// G1b (#17): the agent on AgentCore Runtime. Code deployment of the CommonJS bundle (Node 22), IAM/SigV4
// inbound auth only (decided in #17), idle sessions end after 120 s, least-privilege role. Bundling is
// skipped here (`aws:cdk:bundling-stacks: []`); `pnpm synth` builds the bundle for real.

const config: InfraConfig = exampleConfig();
let templates: Record<string, Template>;

beforeAll(() => {
  const app = buildApp(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), config, SITE_DIR);
  templates = Object.fromEntries(
    app.node
      .findAll()
      .filter((c): c is Stack => Stack.isStack(c))
      .map((s) => [s.stackName, Template.fromStack(s)]),
  );
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

describe('agent stack: the agent on AgentCore Runtime (G1b)', () => {
  it('deploys the CommonJS bundle as code: Node 22, app.js, HTTP, public network, idle sessions end after 120 s', () => {
    tpl('cold-reserve-dev-agent').hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeArtifact: { CodeConfiguration: { Runtime: 'NODE_22', EntryPoint: ['app.js'], Code: { S3: { Bucket: Match.anyValue(), Prefix: Match.anyValue() } } } },
      ProtocolConfiguration: 'HTTP',
      NetworkConfiguration: { NetworkMode: 'PUBLIC' },
      LifecycleConfiguration: Match.objectLike({ IdleRuntimeSessionTimeout: 120 }),
    });
  });

  it('has no authorizer: callers are authenticated by IAM (SigV4) through InvokeAgentRuntime', () => {
    const runtime = Object.values(tpl('cold-reserve-dev-agent').findResources('AWS::BedrockAgentCore::Runtime'))[0] as { Properties: Record<string, unknown> };
    expect(runtime.Properties).not.toHaveProperty('AuthorizerConfiguration');
  });

  it('runs Bedrock with the model of the config, the MCP URL of the mcp stack and the token parameter of its stage, never a token value', () => {
    const t = tpl('cold-reserve-dev-agent');
    t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: Match.objectLike({
        AGENT_MODEL_PROVIDER: 'bedrock',
        AGENT_MODEL_ID: 'us.amazon.nova-2-lite-v1:0',
        AGENT_REGION: 'us-east-1',
        AGENT_MCP_TOKEN_PARAMETER: '/cold-reserve/dev/agent/mcp-token',
        AGENT_MCP_URL: Match.anyValue(),
        // From the one timing table (#270): the agent closes its turn first.
        AGENT_TURN_DEADLINE_MS: '12000',
      }),
    });
    const text = JSON.stringify(t.toJSON());
    expect(text).not.toMatch(/AGENT_MCP_TOKEN"\s*:/);
    expect(text).not.toMatch(/AGENT_INVOKE_TOKEN/);
    // The MCP URL is the Function URL of the mcp stack (an import), with the server's /mcp path.
    expect(text).toMatch(/Fn::ImportValue/);
    expect(text).toContain('mcp"');
  });

  it('has its own role, trusted only by AgentCore for this account', () => {
    tpl('cold-reserve-dev-agent').hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
            Condition: Match.objectLike({ StringEquals: { 'aws:SourceAccount': Match.anyValue() } }),
          }),
        ],
      },
    });
  });

  it('may invoke only the configured model (its inference profile and the model behind it) and read only its token parameter', () => {
    const statements = statementsOf(tpl('cold-reserve-dev-agent'));
    const all = statements.flatMap(actions);
    expect(all).not.toContain('*');
    expect(all.filter((a) => a.endsWith(':*'))).toEqual([]);
    const bedrock = statements.filter((s) => actions(s).some((a) => a.startsWith('bedrock:')));
    expect(bedrock.flatMap(actions).sort()).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
    const text = JSON.stringify(bedrock);
    expect(text).toContain('inference-profile/us.amazon.nova-2-lite-v1:0');
    expect(text).toContain('foundation-model/amazon.nova-2-lite-v1:0');
    const ssm = statements.filter((s) => actions(s).includes('ssm:GetParameter'));
    expect(ssm).toHaveLength(1);
    expect(JSON.stringify(ssm)).toContain('parameter/cold-reserve/dev/agent/mcp-token');
  });

  it('may set up its own runtime logs as the AWS execution role template does: resource policy on its own groups, list the groups', () => {
    // https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html (execution role,
    // direct code deployment). X-Ray and cloudwatch:PutMetricData stay out: only ADOT needs them.
    const statements = statementsOf(tpl('cold-reserve-dev-agent'));
    const logs = (action: string) => statements.filter((s) => actions(s).includes(action));
    expect(JSON.stringify(logs('logs:PutResourcePolicy').map((s) => s.Resource))).toContain('log-group:/aws/bedrock-agentcore/runtimes/cold_reserve_dev_agent-*');
    expect(logs('logs:PutResourcePolicy').flatMap(actions)).toEqual(['logs:PutResourcePolicy']);
    expect(JSON.stringify(logs('logs:DescribeLogGroups').map((s) => s.Resource))).toMatch(/log-group:\*"/);
    expect(logs('logs:DescribeLogGroups').flatMap(actions)).toEqual(['logs:DescribeLogGroups']);
    const all = statements.flatMap(actions);
    expect(all.filter((a) => a.startsWith('xray:') || a === 'cloudwatch:PutMetricData')).toEqual([]);
  });

  it('exists for every stage, with the token parameter of that stage', () => {
    tpl('cold-reserve-demo-agent').hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: Match.objectLike({ AGENT_MCP_TOKEN_PARAMETER: '/cold-reserve/demo/agent/mcp-token' }),
    });
  });
});

describe('loadInfraConfig for the agent settings', () => {
  const context = (agent: unknown) => (key: string) =>
    ({ 'cold-reserve:region': config.region, 'cold-reserve:stages': config.stages, 'cold-reserve:mcp': config.mcp, 'cold-reserve:state': config.state, 'cold-reserve:agent': agent, 'cold-reserve:simApi': config.simApi, 'cold-reserve:turnTiming': config.turnTiming, 'cold-reserve:alexa': config.alexa })[key];

  it('reads them from the CDK context', () => {
    expect(loadInfraConfig(context(config.agent))).toEqual({ ok: true, value: config });
  });

  it.each([
    ['a missing agent section', undefined],
    ['an idle timeout under a minute', { ...config.agent, idleRuntimeSessionTimeoutSeconds: 30 }],
    ['a token parameter without {stage}', { ...config.agent, mcpTokenParameter: '/cold-reserve/agent/mcp-token' }],
    ['a model id that is not an inference profile', { ...config.agent, modelId: 'nova lite' }],
  ])('rejects %s with invalid_config', (_name, agent) => {
    expect(loadInfraConfig(context(agent))).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});
