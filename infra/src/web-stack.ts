import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, Token, Validations, type StackProps } from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  Function as EdgeFunction,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  HttpVersion,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  PriceClass,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership, type IBucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, CacheControl, Source } from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';
import type { StageName } from './config.js';

// K1 (#242): the simulator website (apps/alexa-sim) per stage. A private bucket served only by CloudFront through
// Origin Access Control; sim-api behind the same distribution at /api, so the site and its API share one origin
// (no CORS, no cycle between the stacks); the CSP the site computed at build time (security-headers.json); the
// build uploaded by CDK with a long cache for hashed assets and none for index.html. Deploys are manual and
// reserved to the owner.

export interface WebStackProps extends StackProps {
  readonly stage: StageName;
  /** The built site: `pnpm --filter @cold-reserve/alexa-sim build:aws` (dist, with security-headers.json). */
  readonly siteDir: string;
  /** The sim-api Function URL (https://<id>.lambda-url.<region>.on.aws/). */
  readonly simApiUrl: string;
  /**
   * The SSM String parameter of the origin secret (#243), added to every /api request so sim-api refuses any other
   * caller. Resolved by CloudFormation at deploy: the template holds the reference, never the value.
   */
  readonly originSecretParameter: string;
}

/** CloudFront Function (viewer request) in front of sim-api at /api/*: see infra/cloudfront/api-viewer-request.js. */
export const viewerRequestCode = readFileSync(fileURLToPath(new URL('../cloudfront/api-viewer-request.js', import.meta.url)), 'utf8');

const ONE_YEAR = Duration.days(365);

/** How cdk-nag writes a stack value in a finding id: the value itself, or <AWS::Name> while it is a token. */
const nagValue = (value: string, pseudo: string) => (Token.isUnresolved(value) ? `<AWS::${pseudo}>` : value);

/**
 * A Bucket is an IBucket; only `isWebsite?` in the CDK declarations clashes with exactOptionalPropertyTypes, so the
 * buckets are handed to the other constructs through this one cast.
 */
const asIBucket = (bucket: Bucket): IBucket => bucket as unknown as IBucket;

function siteCsp(siteDir: string): string {
  const file = join(siteDir, 'security-headers.json');
  if (!existsSync(file)) {
    throw new Error(`${file} is missing: build the site first with pnpm --filter @cold-reserve/alexa-sim build:aws`);
  }
  return (JSON.parse(readFileSync(file, 'utf8')) as { contentSecurityPolicy: string }).contentSecurityPolicy;
}

export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { stage, siteDir } = props;
    const csp = siteCsp(siteDir);
    // demo is what the judges see: it is kept; dev is torn down when idle (cost rule).
    const removable = stage === 'dev' ? { removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true } : { removalPolicy: RemovalPolicy.RETAIN };

    // CloudFront standard logs need ACLs on their bucket (object writer); nothing here is public.
    const logs = new Bucket(this, 'Logs', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      ...removable,
    });
    // cdk-nag 3 findings are acknowledged through CDK Validations, each with its reason.
    Validations.of(logs).acknowledge({ id: 'AwsSolutions-S1', reason: 'This is the access-log bucket itself: logging it into itself would loop.' });

    const site = new Bucket(this, 'Site', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      serverAccessLogsBucket: asIBucket(logs),
      serverAccessLogsPrefix: 's3/',
      ...removable,
    });

    const headers = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: `cold-reserve ${stage}: CSP from the site build, HSTS, no framing`,
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        strictTransportSecurity: { accessControlMaxAge: ONE_YEAR, includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
      // Speech recognition needs the microphone, for this site only.
      customHeadersBehavior: { customHeaders: [{ header: 'Permissions-Policy', value: 'microphone=(self), camera=(), geolocation=()', override: true }] },
    });

    const viewerRequest = new EdgeFunction(this, 'ApiViewerRequest', { code: FunctionCode.fromInline(viewerRequestCode), runtime: FunctionRuntime.JS_2_0 });
    const distribution = new Distribution(this, 'Distribution', {
      comment: `cold-reserve ${stage} simulator`,
      defaultRootObject: 'index.html',
      priceClass: PriceClass.PRICE_CLASS_100,
      httpVersion: HttpVersion.HTTP2_AND_3,
      enableLogging: true,
      logBucket: asIBucket(logs),
      logFilePrefix: 'cloudfront/',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(asIBucket(site)),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
      },
      additionalBehaviors: {
        // Same origin as the site: the API answers through CloudFront, never cached, with its own Host header.
        '/api/*': {
          origin: new HttpOrigin(Fn.select(2, Fn.split('/', props.simApiUrl)), {
            protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
            customHeaders: { 'x-origin-verify': `{{resolve:ssm:${props.originSecretParameter}}}` },
          }),
          viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
          functionAssociations: [{ function: viewerRequest, eventType: FunctionEventType.VIEWER_REQUEST }],
        },
      },
    });
    Validations.of(distribution).acknowledge(
      { id: 'AwsSolutions-CFR1', reason: 'A private demo for a hackathon jury anywhere in the world: no geo restriction.' },
      {
        id: 'AwsSolutions-CFR2',
        reason: 'No WAF: about $5+ a month, against the zero out-of-pocket rule. The demo caps per code and overall, and the kill switch, are the compensating control.',
      },
      { id: 'AwsSolutions-CFR4', reason: 'No custom domain: the default *.cloudfront.net certificate, whose TLS policy CloudFront sets.' },
    );

    // Vite's hashed assets/ first, cached for a year (their names change with their content); then every other file
    // (index.html, any public/ file), never cached, with one invalidation. Old assets stay (no prune) for pages
    // already open. Never source maps, never the build's header file.
    const assets = new BucketDeployment(this, 'Assets', {
      sources: [Source.asset(siteDir, { exclude: ['*', '!assets', '!assets/**', '**/*.map'] })],
      destinationBucket: asIBucket(site),
      cacheControl: [CacheControl.fromString('public, max-age=31536000, immutable')],
      prune: false,
    });
    const index = new BucketDeployment(this, 'Index', {
      sources: [Source.asset(siteDir, { exclude: ['assets', 'assets/**', '*.map', '**/*.map', 'security-headers.json'] })],
      destinationBucket: asIBucket(site),
      cacheControl: [CacheControl.noCache()],
      prune: false,
      distribution,
      distributionPaths: ['/*'],
    });
    index.node.addDependency(assets);
    // The upload runs in CDK's own deployment handler (one per stack, at deploy time only): its role and runtime are
    // CDK's, not ours to scope further. Each finding is acknowledged on that handler alone.
    const handler = this.node.children.find((c) => c.node.id.startsWith('Custom::CDKBucketDeployment'));
    if (handler === undefined) throw new Error('The CDK bucket deployment handler was not found.');
    Validations.of(handler).acknowledge(
      { id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]', reason: "CDK's BucketDeployment handler writes its own logs with the basic execution role." },
      { id: 'AwsSolutions-IAM5[Action::s3:GetObject*]', reason: 'CDK grants its deployment handler read on the CDK asset bucket, to copy the build.' },
      { id: 'AwsSolutions-IAM5[Action::s3:GetBucket*]', reason: 'CDK grants its deployment handler read on the CDK asset bucket, to copy the build.' },
      { id: 'AwsSolutions-IAM5[Action::s3:List*]', reason: 'CDK grants its deployment handler list on the asset and site buckets, to copy the build.' },
      { id: 'AwsSolutions-IAM5[Action::s3:DeleteObject*]', reason: "CDK grants its deployment handler write on this stack's site bucket only." },
      { id: 'AwsSolutions-IAM5[Action::s3:Abort*]', reason: "CDK grants its deployment handler write on this stack's site bucket only." },
      { id: 'AwsSolutions-IAM5[Resource::<SiteE53D7754.Arn>/*]', reason: "The objects of this stack's own site bucket, where the build is copied." },
      { id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-${nagValue(this.account, 'AccountId')}-${nagValue(this.region, 'Region')}/*]`, reason: 'The CDK bootstrap asset bucket, where the build is staged.' },
      { id: 'AwsSolutions-IAM5[Resource::*]', reason: 'cloudfront:CreateInvalidation and GetInvalidation, which CDK grants on "*" for the one invalidation per deploy.' },
      { id: 'AwsSolutions-L1', reason: "The runtime of CDK's own deployment handler, set by aws-cdk-lib." },
    );

    new CfnOutput(this, 'SiteUrl', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'SiteBucketName', { value: site.bucketName });
  }
}
