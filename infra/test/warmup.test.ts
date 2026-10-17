import { readFileSync } from 'node:fs';
import { WARMUP_EVENT } from '@cold-reserve/core';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { InfraConfigSchema, buildApp, type InfraConfig } from '../src/index.js';
import { SITE_DIR, exampleConfig } from './fixtures.js';

// The scheduled warm-up (#407): off by default; switched on per stage, one rule in each of the sim-api and MCP
// stacks, each invoking only its own function with the fixed warm-up event. Never the agent. Bundling is skipped.

type Resource = { Type: string; Properties: Record<string, unknown> };
type Target = { Arn: unknown; Input: string; RetryPolicy?: { MaximumRetryAttempts?: number } };

const synth = (cfg: InfraConfig) => {
  const app = buildApp(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), cfg, SITE_DIR);
  app.synth(); // the cdk-nag checks run here: any finding fails the test
  return Object.fromEntries(
    app.node
      .findAll()
      .filter((c): c is Stack => Stack.isStack(c))
      .map((s) => [s.stackName, Template.fromStack(s)]),
  );
};
const resourcesOf = (t: Template, type: string) => Object.entries(t.findResources(type)) as [string, Resource][];
const rulesByStack = (templates: Record<string, Template>) =>
  Object.fromEntries(
    Object.entries(templates)
      .map(([name, t]) => [name, resourcesOf(t, 'AWS::Events::Rule')] as const)
      .filter(([, rules]) => rules.length > 0),
  );
const withWarmup = (enabled: InfraConfig['warmup']['enabled']): InfraConfig => ({ ...exampleConfig(), warmup: { enabled, rateMinutes: 5 } });

let off: Record<string, Template>;
let devOn: Record<string, Template>;
beforeAll(() => {
  off = synth(exampleConfig());
  devOn = synth(withWarmup({ dev: true, demo: false }));
}, 120_000);

describe('the warm-up schedule (#407)', () => {
  it('is off on every stage in the shipped cdk.json, and the rate must be under 15 minutes', () => {
    const cdk = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as { context: Record<string, unknown> };
    expect(cdk.context['cold-reserve:warmup']).toEqual({ enabled: { dev: false, demo: false }, rateMinutes: 5 });
    const withoutWarmup: Partial<InfraConfig> = exampleConfig();
    delete withoutWarmup.warmup;
    expect(InfraConfigSchema.parse(withoutWarmup).warmup.enabled).toEqual({ dev: false, demo: false });
    expect(InfraConfigSchema.safeParse({ ...exampleConfig(), warmup: { enabled: { dev: true, demo: true }, rateMinutes: 15 } }).success).toBe(false);
    expect(InfraConfigSchema.safeParse({ ...exampleConfig(), warmup: { enabled: { dev: 'yes', demo: false }, rateMinutes: 5 } }).success).toBe(false);
  });

  it('creates no rule at all when it is off', () => {
    expect(rulesByStack(off)).toEqual({});
  });

  it('when on for a stage: one rule in the sim-api stack and one in the MCP stack of that stage, none elsewhere (never the agent)', () => {
    expect(Object.keys(rulesByStack(devOn)).sort()).toEqual(['cold-reserve-dev-mcp', 'cold-reserve-dev-sim-api']);
    for (const rules of Object.values(rulesByStack(devOn))) expect(rules).toHaveLength(1);
  });

  it.each([
    ['cold-reserve-dev-mcp', 'Server'],
    ['cold-reserve-dev-sim-api', 'Api'],
  ])('%s: every 5 minutes, exactly one target, its own function, the fixed warm-up event, no retries', (stackName, functionId) => {
    const t = devOn[stackName];
    if (!t) throw new Error(`No stack ${stackName}`);
    const [ruleId, rule] = resourcesOf(t, 'AWS::Events::Rule')[0] ?? [];
    expect(rule?.Properties).toMatchObject({ ScheduleExpression: 'rate(5 minutes)', State: 'ENABLED' });
    const targets = rule?.Properties['Targets'] as Target[];
    expect(targets).toHaveLength(1);
    const fnId = resourcesOf(t, 'AWS::Lambda::Function').find(([id]) => id.startsWith(functionId))?.[0];
    expect(fnId).toBeDefined();
    expect(targets[0]?.Arn).toEqual({ 'Fn::GetAtt': [fnId, 'Arn'] });
    expect(JSON.parse(targets[0]?.Input ?? 'null')).toEqual(WARMUP_EVENT);
    expect(targets[0]?.RetryPolicy?.MaximumRetryAttempts).toBe(0);

    // Least privilege: EventBridge may invoke this one function, and only from this rule.
    const fromEvents = resourcesOf(t, 'AWS::Lambda::Permission').filter(([, p]) => p.Properties['Principal'] === 'events.amazonaws.com');
    expect(fromEvents.map(([, p]) => p.Properties)).toEqual([{ Action: 'lambda:InvokeFunction', FunctionName: { 'Fn::GetAtt': [fnId, 'Arn'] }, Principal: 'events.amazonaws.com', SourceArn: { 'Fn::GetAtt': [ruleId, 'Arn'] } }]);
  });

  it('adds no permission for EventBridge anywhere when it is off', () => {
    for (const t of Object.values(off)) {
      expect(resourcesOf(t, 'AWS::Lambda::Permission').filter(([, p]) => p.Properties['Principal'] === 'events.amazonaws.com')).toEqual([]);
    }
  });
});
