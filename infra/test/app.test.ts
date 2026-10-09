import { readFileSync } from 'node:fs';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { beforeAll, describe, expect, it } from 'vitest';
import { InfraConfigSchema, applyGuardrails, buildApp, loadInfraConfig, simApiAgentTimeoutMs, type InfraConfig } from '../src/index.js';
import { SITE_DIR, exampleConfig } from './fixtures.js';

const config: InfraConfig = exampleConfig();
// Bundling the Lambda is left to `pnpm synth`; tests synthesize the templates only.
const newApp = () => new App({ context: { 'aws:cdk:bundling-stacks': [] } });

const stacksOf = (app: App) => app.node.findAll().filter((c): c is Stack => Stack.isStack(c));

describe('loadInfraConfig (region and stages always from config)', () => {
  it('reads the cdk.json context', () => {
    const context: Record<string, unknown> = { 'cold-reserve:region': 'us-east-1', 'cold-reserve:stages': ['dev', 'demo'], 'cold-reserve:mcp': config.mcp, 'cold-reserve:state': config.state, 'cold-reserve:agent': config.agent, 'cold-reserve:simApi': config.simApi, 'cold-reserve:turnTiming': config.turnTiming };
    expect(loadInfraConfig((key) => context[key])).toEqual({ ok: true, value: config });
  });

  it('accepts the real infra/cdk.json as it is, so synth never meets a key the schema refuses (#270)', () => {
    const cdk = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as { context: Record<string, unknown> };
    expect(loadInfraConfig((key) => cdk.context[key])).toMatchObject({ ok: true });
  });

  it('rejects a missing or malformed region with invalid_config', () => {
    const result = loadInfraConfig((key) => ({ 'cold-reserve:region': 'US East', 'cold-reserve:stages': ['dev'] })[key]);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config', category: 'internal' } });
  });

  it('the turn timing table (#270): agent + margin = sim-api < browser < turn budget < the sim-api function; every link refused when inverted', () => {
    expect(config.turnTiming).toEqual({ agentDeadlineMs: 12_000, agentMarginMs: 2000, browserTimeoutMs: 16_000, turnBudgetMs: 18_000 });
    const timing = (over: Partial<InfraConfig['turnTiming']>, simApi: Partial<InfraConfig['simApi']> = {}) =>
      InfraConfigSchema.safeParse({ ...config, turnTiming: { ...config.turnTiming, ...over }, simApi: { ...config.simApi, ...simApi } });
    expect(timing({}).success).toBe(true);
    for (const bad of [{ browserTimeoutMs: 14_000 }, { turnBudgetMs: 16_000 }, { agentDeadlineMs: 15_000 }]) {
      const r = timing(bad);
      expect(r.success, JSON.stringify(bad)).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain('turnTiming');
    }
    expect(timing({ turnBudgetMs: 33_000 }, { timeoutSeconds: 32 }).success).toBe(false);
    expect(simApiAgentTimeoutMs(config.turnTiming)).toBe(14_000);
  });

  it('accepts only the dev and demo stages', () => {
    const result = loadInfraConfig((key) => ({ 'cold-reserve:region': 'us-east-1', 'cold-reserve:stages': ['prod'] })[key]);
    expect(result.ok).toBe(false);
  });
});

describe('buildApp', () => {
  // The first synth in a process loads most of aws-cdk-lib: ~10 s idle, 27 s on the old PC under load
  // (issue #53), while later synths take well under 2 s. Pay that once here, with its own timeout,
  // so the assertions below keep the normal test timeout.
  beforeAll(() => {
    buildApp(newApp(), config, SITE_DIR).synth();
  }, 90_000);

  it('every metric filter dimension reads a log field ($.), never a constant: CloudFormation refuses a constant and synth does not catch it (#275)', () => {
    const app = buildApp(newApp(), config, SITE_DIR);
    const values = stacksOf(app).flatMap((stack) =>
      Object.values(Template.fromStack(stack).findResources('AWS::Logs::MetricFilter')).flatMap((r) =>
        ((r as { Properties: { MetricTransformations: { Dimensions?: { Value: string }[] }[] } }).Properties.MetricTransformations).flatMap((m) => (m.Dimensions ?? []).map((d) => d.Value)),
      ),
    );
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v).toMatch(/^\$\./);
  });

  it('creates one foundation stack per stage, in the configured region', () => {
    const app = buildApp(newApp(), { ...config, region: 'eu-south-1' }, SITE_DIR);
    const stacks = stacksOf(app);
    expect(stacks.map((s) => s.stackName).filter((n) => n.endsWith('-foundation')).sort()).toEqual(['cold-reserve-demo-foundation', 'cold-reserve-dev-foundation']);
    expect(stacks.every((s) => s.region === 'eu-south-1')).toBe(true);
  });

  it('protects the demo stage from deletion, not dev', () => {
    const stacks = stacksOf(buildApp(newApp(), config, SITE_DIR));
    const byName = Object.fromEntries(stacks.map((s) => [s.stackName, s.terminationProtection]));
    expect(byName).toMatchObject({ 'cold-reserve-dev-foundation': false, 'cold-reserve-demo-foundation': true, 'cold-reserve-dev-mcp': false, 'cold-reserve-demo-data': true });
  });

  it('tags every stack with the project and the stage', () => {
    const app = buildApp(newApp(), config, SITE_DIR);
    const dev = stacksOf(app).find((s) => s.stackName === 'cold-reserve-dev-foundation');
    expect(dev?.tags.tagValues()).toMatchObject({ project: 'cold-reserve', stage: 'dev' });
  });

  it('synthesizes with the cdk-nag AwsSolutions checks passing', () => {
    expect(() => buildApp(newApp(), config, SITE_DIR).synth()).not.toThrow();
  });

  it('keeps every stack deployable (CloudFormation needs at least one resource)', () => {
    for (const stack of stacksOf(buildApp(newApp(), config, SITE_DIR))) {
      const template = Template.fromStack(stack).toJSON() as { Resources?: Record<string, unknown> };
      expect(Object.keys(template.Resources ?? {})).not.toHaveLength(0);
    }
  });
});

describe('applyGuardrails (cdk-nag 3 as a CDK validation plugin)', () => {
  it('fails the synth on a non-compliant resource', () => {
    const app = applyGuardrails(new App());
    new Bucket(new Stack(app, 'probe', { env: { region: 'us-east-1' } }), 'Unencrypted');
    expect(() => app.synth()).toThrow(/AwsSolutions-S1/);
  });
});
