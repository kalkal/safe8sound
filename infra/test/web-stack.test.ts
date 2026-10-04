import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { WebStack, applyGuardrails, buildApp, viewerRequestCode, type StageName } from '../src/index.js';
import { SITE_DIR, exampleConfig } from './fixtures.js';

// K1 (#242): the simulator website per stage. A private bucket behind CloudFront with Origin Access Control, sim-api
// behind the same distribution at /api (same origin: no CORS), the CSP the site computed at build time, and the
// build uploaded by CDK with a long cache for hashed assets and none for index.html. cdk-nag runs on every synth.

const SIM_API_URL = 'https://abc123.lambda-url.us-east-1.on.aws/';
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const ALL_VIEWER_EXCEPT_HOST = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';
const fixtureCsp = (JSON.parse(readFileSync(join(SITE_DIR, 'security-headers.json'), 'utf8')) as { contentSecurityPolicy: string }).contentSecurityPolicy;

function synth(stage: StageName = 'dev', siteDir = SITE_DIR, outdir?: string): Template {
  const app = applyGuardrails(new App({ context: { 'aws:cdk:bundling-stacks': [] }, ...(outdir === undefined ? {} : { outdir }) }));
  const stack = new WebStack(app, 'web', { env: { region: 'us-east-1', account: '111122223333' }, stage, siteDir, simApiUrl: SIM_API_URL, originSecretParameter: `/cold-reserve/${stage}/sim-api/origin-secret` });
  app.synth(); // the cdk-nag checks run here: any finding fails the test
  return Template.fromStack(stack);
}

describe('the site bucket', () => {
  it('is private, SSL only and encrypted; only this distribution may read it', () => {
    const t = synth();
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      BucketEncryption: Match.anyValue(),
      LoggingConfiguration: Match.objectLike({ LogFilePrefix: 's3/' }),
    });
    const policies = JSON.stringify(t.findResources('AWS::S3::BucketPolicy'));
    expect(policies).toContain('"aws:SecureTransport":"false"');
    expect(policies).toContain('cloudfront.amazonaws.com');
    expect(policies).toContain('AWS:SourceArn');
    expect(policies).not.toMatch(/"Principal":"\*","Action":"s3:GetObject"/);
  });

  it('is emptied and removed with the dev stage, kept with the demo stage', () => {
    expect(JSON.stringify(synth('dev').findResources('AWS::S3::Bucket'))).toContain('"DeletionPolicy":"Delete"');
    expect(JSON.stringify(synth('demo').findResources('AWS::S3::Bucket'))).not.toContain('"DeletionPolicy":"Delete"');
  });
});

describe('the distribution', () => {
  const t = synth();
  const config = () => (Object.values(t.findResources('AWS::CloudFront::Distribution'))[0] as { Properties: { DistributionConfig: Record<string, unknown> } }).Properties.DistributionConfig;

  it('serves the site over HTTPS only, from the bucket through Origin Access Control, with index.html at the root', () => {
    t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    expect(config()).toMatchObject({ DefaultRootObject: 'index.html', PriceClass: 'PriceClass_100', HttpVersion: 'http2and3', DefaultCacheBehavior: { ViewerProtocolPolicy: 'redirect-to-https' } });
    expect(JSON.stringify(config()['Logging'])).toContain('cloudfront/');
  });

  it('sends /api/* to sim-api, never cached, every method, without the viewer Host header, with the /api prefix stripped', () => {
    const behaviors = config()['CacheBehaviors'] as Array<Record<string, unknown>>;
    expect(behaviors).toHaveLength(1);
    expect(behaviors[0]).toMatchObject({
      PathPattern: '/api/*',
      CachePolicyId: CACHING_DISABLED,
      OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
      ViewerProtocolPolicy: 'https-only',
      AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
    });
    expect(JSON.stringify(behaviors[0]?.['FunctionAssociations'])).toContain('viewer-request');
    expect(JSON.stringify(config()['Origins'])).toContain('abc123.lambda-url.us-east-1.on.aws');
  });

  it('adds the origin secret to every /api request, as a reference resolved at deploy, never a value (#243)', () => {
    const origins = config()['Origins'] as Array<{ DomainName: unknown; OriginCustomHeaders?: Array<{ HeaderName: string; HeaderValue: string }> }>;
    const api = origins.find((o) => JSON.stringify(o.DomainName).includes('lambda-url'));
    expect(api?.OriginCustomHeaders).toEqual([{ HeaderName: 'x-origin-verify', HeaderValue: '{{resolve:ssm:/cold-reserve/dev/sim-api/origin-secret}}' }]);
    // The site bucket's origin carries no secret.
    expect(origins.filter((o) => o.OriginCustomHeaders !== undefined)).toHaveLength(1);
  });

  it('answers with the CSP the site was built with, HSTS, no framing, nosniff, and the microphone for itself only', () => {
    t.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: { ContentSecurityPolicy: fixtureCsp, Override: true },
          StrictTransportSecurity: Match.objectLike({ AccessControlMaxAgeSec: 31_536_000, IncludeSubdomains: true, Override: true }),
          FrameOptions: { FrameOption: 'DENY', Override: true },
          ContentTypeOptions: { Override: true },
          ReferrerPolicy: { ReferrerPolicy: 'strict-origin-when-cross-origin', Override: true },
        }),
        CustomHeadersConfig: { Items: [Match.objectLike({ Header: 'Permissions-Policy', Value: 'microphone=(self), camera=(), geolocation=()' })] },
      }),
    });
  });

  it('gives the site URL, the distribution id and the bucket name as outputs', () => {
    expect(Object.keys(t.findOutputs('*')).sort()).toEqual(['DistributionId', 'SiteBucketName', 'SiteUrl']);
  });
});

describe('the upload of the build', () => {
  it('caches only the hashed assets/ for a year, every other file never, invalidates, and ships no source map or header file', () => {
    const outdir = mkdtempSync(join(tmpdir(), 'web-stack-'));
    const t = synth('dev', SITE_DIR, outdir);
    const deployments = Object.values(t.findResources('Custom::CDKBucketDeployment')) as Array<{ Properties: Record<string, unknown> }>;
    expect(deployments).toHaveLength(2);
    const metadata = deployments.map((d) => JSON.stringify(d.Properties['SystemMetadata'] ?? {}));
    expect(metadata).toContainEqual(expect.stringContaining('public, max-age=31536000, immutable'));
    expect(metadata).toContainEqual(expect.stringContaining('no-cache'));
    expect(deployments.some((d) => JSON.stringify(d.Properties['DistributionPaths']) === '["/*"]')).toBe(true);
    expect(deployments.every((d) => d.Properties['Prune'] === false)).toBe(true);

    // What CDK staged for upload: assets/ alone (immutable), and the rest of the build (no-cache); never maps or headers.
    const staged = readdirSync(outdir).filter((name) => name.startsWith('asset.') && statSync(join(outdir, name)).isDirectory());
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)).map((f) => `${name}/${f}`) : [name]));
    const uploads = staged.map((dir) => files(join(outdir, dir)).sort()).filter((list) => list.some((f) => f === 'index.html' || f.startsWith('assets/')));
    expect(uploads).toContainEqual(['assets/index-Ab12Cd34.js']);
    expect(uploads).toContainEqual(['favicon.svg', 'index.html']);
    expect(uploads.flat().some((f) => f.endsWith('.map') || f === 'security-headers.json')).toBe(false);
  });

  it('refuses a site without its security headers, with a message that says how to build it', () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-site-'));
    expect(() => synth('dev', empty)).toThrow(/security-headers\.json.*build:aws/);
  });
});

describe('the CloudFront Function in front of sim-api', () => {
  type Headers = Record<string, { value: string } | undefined>;
  interface Out { uri?: string; headers?: Headers; statusCode?: number; body?: { data: string } }
  // In a context of its own, as CloudFront runs it: only the function's code and the event.
  const run = (uri: string, headers: Headers = { host: { value: 'd111.cloudfront.net' } }) =>
    runInNewContext(`${viewerRequestCode}
handler(event);`, { event: { viewer: { ip: '203.0.113.7' }, request: { uri, headers } } }) as Out;

  it.each([
    ['/api/v1/turns', '/v1/turns'],
    ['/api/v1/session', '/v1/session'],
    ['/api', '/'],
    ['/api/', '/'],
  ])('turns %s into %s', (uri, expected) => {
    expect(run(uri).uri).toBe(expected);
  });

  it("drops the site's own Origin: sim-api sees a same-origin call (#244 review)", () => {
    const out = run('/api/v1/turns', { host: { value: 'd111.cloudfront.net' }, origin: { value: 'https://d111.cloudfront.net' } });
    expect(out.uri).toBe('/v1/turns');
    expect(out.headers?.['origin']).toBeUndefined();
  });

  it('refuses any other Origin with 403, before sim-api', () => {
    const out = run('/api/v1/session', { host: { value: 'd111.cloudfront.net' }, origin: { value: 'https://evil.example' } });
    expect(out.statusCode).toBe(403);
    expect(JSON.parse(out.body?.data ?? '{}')).toMatchObject({ status: 403, code: 'origin_not_allowed' });
  });

  it("names the visitor's IP for sim-api's per-IP limit, overwriting whatever the client sent", () => {
    expect(run('/api/v1/session').headers?.['x-viewer-ip']).toEqual({ value: '203.0.113.7' });
    const forged = run('/api/v1/session', { host: { value: 'd111.cloudfront.net' }, 'x-viewer-ip': { value: '198.51.100.1' } });
    expect(forged.headers?.['x-viewer-ip']).toEqual({ value: '203.0.113.7' });
  });
});

describe('the app wires a web stack in every stage, after sim-api', () => {
  it('reads the sim-api URL from the sim-api stack of the same stage', () => {
    const app = buildApp(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), exampleConfig(), SITE_DIR);
    const stacks = app.node.findAll().filter((c): c is Stack => Stack.isStack(c));
    for (const stage of ['dev', 'demo']) {
      const web = stacks.find((s) => s.stackName === `cold-reserve-${stage}-web`);
      if (!web) throw new Error(`No web stack for ${stage}`);
      expect(JSON.stringify(Template.fromStack(web).toJSON())).toContain(`cold-reserve-${stage}-sim-api:`);
    }
  });
});
