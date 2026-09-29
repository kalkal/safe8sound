import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyGuardrails, buildApp, loadInfraConfig, type InfraConfig } from '../src/index.js';

const config: InfraConfig = { region: 'us-east-1', stages: ['dev', 'demo'] };

const stacksOf = (app: App) => app.node.findAll().filter((c): c is Stack => Stack.isStack(c));

describe('loadInfraConfig (region and stages always from config)', () => {
  it('reads the cdk.json context', () => {
    const result = loadInfraConfig((key) => ({ 'cold-reserve:region': 'us-east-1', 'cold-reserve:stages': ['dev', 'demo'] })[key]);
    expect(result).toEqual({ ok: true, value: config });
  });

  it('rejects a missing or malformed region with invalid_config', () => {
    const result = loadInfraConfig((key) => ({ 'cold-reserve:region': 'US East', 'cold-reserve:stages': ['dev'] })[key]);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config', category: 'internal' } });
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
    buildApp(new App(), config).synth();
  }, 90_000);

  it('creates one foundation stack per stage, in the configured region', () => {
    const app = buildApp(new App(), { region: 'eu-south-1', stages: ['dev', 'demo'] });
    const stacks = stacksOf(app);
    expect(stacks.map((s) => s.stackName).sort()).toEqual(['cold-reserve-demo-foundation', 'cold-reserve-dev-foundation']);
    expect(stacks.every((s) => s.region === 'eu-south-1')).toBe(true);
  });

  it('protects the demo stage from deletion, not dev', () => {
    const stacks = stacksOf(buildApp(new App(), config));
    const byName = Object.fromEntries(stacks.map((s) => [s.stackName, s.terminationProtection]));
    expect(byName).toEqual({ 'cold-reserve-dev-foundation': false, 'cold-reserve-demo-foundation': true });
  });

  it('tags every stack with the project and the stage', () => {
    const app = buildApp(new App(), config);
    const dev = stacksOf(app).find((s) => s.stackName === 'cold-reserve-dev-foundation');
    expect(dev?.tags.tagValues()).toMatchObject({ project: 'cold-reserve', stage: 'dev' });
  });

  it('synthesizes with the cdk-nag AwsSolutions checks passing', () => {
    expect(() => buildApp(new App(), config).synth()).not.toThrow();
  });

  it('keeps every stack deployable (CloudFormation needs at least one resource)', () => {
    for (const stack of stacksOf(buildApp(new App(), config))) {
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
