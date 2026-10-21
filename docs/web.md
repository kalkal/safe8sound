# The simulator website on AWS (K1, #242)

The Alexa+ simulator (`apps/alexa-sim`) is served per stage (`dev`, `demo`) by `infra/src/web-stack.ts`.

## What runs
- **Site bucket:** a private S3 bucket (all public access blocked, SSL only, S3-managed encryption). It is removed with `dev` and kept with `demo`.
- **Distribution:** CloudFront with Origin Access Control: only this distribution can read the bucket. HTTPS only, HTTP/2 and 3, price class 100. `index.html` is at the root.
- **sim-api at `/api/*`:** the same distribution forwards `/api/*` to the sim-api Function URL. The behaviour is never cached, allows every method, and sends every viewer header except `Host` (`Authorization` included). The site and its API share one origin, so there is no CORS. On AWS `sim-api`'s `allowedOrigins` is empty: the list is for local development only.
- **The CloudFront Function** (`infra/cloudfront/api-viewer-request.js`, viewer request on `/api/*`):
  - it strips `/api`, so `/api/v1/turns` reaches the function as `/v1/turns`;
  - the browser sends `Origin` on every POST, even same-origin: the site's own origin is dropped, and any other is refused with 403 `origin_not_allowed` before sim-api;
  - it writes the visitor's IP in `x-viewer-ip`, always overwriting what the client sent. Behind CloudFront the Function URL only sees the edge's IP. sim-api uses the header for its per-IP demo code limit only on a request that proves it came through the distribution (#243).
- **Logs:** CloudFront standard logs and the site bucket's access logs go to a private log bucket, kept 30 days. **They hold the visitors' IP addresses for those 30 days**: the privacy notice must say so.
- **Outputs:** `SiteUrl`, `DistributionId`, `SiteBucketName`.

## Security headers
- **CSP:** the site computes its Content-Security-Policy when it is built (`apps/alexa-sim/scripts/site-headers.ts` → `dist/security-headers.json`), because it knows what it loads. The hashes come from the plan card's document: every card kind inlines the same script and the same style, so one pair covers them all.
  - Only `'self'`, plus the card's one inline script and one inline style by SHA-256 hash.
  - The cards are `srcdoc` iframes and inherit the page's policy, so they need the hashes.
  - Never `'unsafe-inline'` or `'unsafe-eval'`, never a remote origin. `media-src blob:` is there for the Polly audio.
- The web stack reads that file at synth and serves it with HSTS (1 year), `X-Frame-Options: DENY`, `nosniff`, `strict-origin-when-cross-origin` and `Permissions-Policy: microphone=(self)`.
- `pnpm e2e:site` (`playwright.site.config.ts`, its own run) checks the built site:
  - `e2e/site/csp.spec.ts` serves the scripted build with the same headers file and fails on any CSP violation, in the page or in a card;
  - `e2e/site/turn.spec.ts` serves the AWS build behind a stand-in for CloudFront (`apps/alexa-sim/vite.cloudfront-preview.ts`). The stand-in runs the real CloudFront Function in front of the real local chain: sim-api with no allowed origin, the agent with the fake model, and the MCP server. A demo code and a turn go through `/api`, and a foreign origin is refused at the edge.

## Build and upload
- `pnpm synth` first runs `pnpm --filter @cold-reserve/alexa-sim build:aws`. That build uses the remote agent and `VITE_SIM_API_URL=/api` (assigned in `vite.config.ts` for `--mode aws`, so a `VITE_AGENT` left in the shell never ships; no secrets) and writes the headers file. It builds the card bundle first (`pnpm --filter @cold-reserve/ui-cards build:card`, #503), and the simulator's Vite config refuses to serve or build with a bundle older than its sources (ui-cards, contracts, i18n, design tokens).
- Two `BucketDeployment`s upload the build:
  - Vite's hashed `assets/` with `public, max-age=31536000, immutable`;
  - then every other file (`index.html`, any `public/` file) with `no-cache`, and one invalidation of `/*`.
- Source maps and the headers file are never uploaded. Old assets are kept (no prune) for pages already open.

## cdk-nag
Clean. Each acknowledged finding has its reason in the code:
- the log bucket's own access logs (S1);
- no geo restriction (CFR1);
- no WAF (CFR2): it would cost money; the demo caps and the kill switch are the compensating control;
- the default `*.cloudfront.net` certificate (CFR4);
- the role and runtime of CDK's own BucketDeployment handler (IAM4, IAM5, L1).

## Cost
- CloudFront stays in its always-free tier (1 TB out and 10 M requests a month).
- S3 costs cents.
- The deployment handler runs only at deploy time.
- No WAF, no domain, no certificate.

## Only through the site (#243)
- **The secret:** the distribution adds `x-origin-verify` to every `/api` request. Its value is the SSM String parameter `/cold-reserve/<stage>/sim-api/origin-secret`, resolved by CloudFormation at deploy: the template holds only the reference.
- **Fail closed:** on AWS sim-api does not start if `origin-secret` holds `none` or nothing (`invalid_config`); `none` is only for `origin-secret-previous`. Each container says `Origin secret check: on.` once, without the value.
- **The refusal:** on AWS, sim-api refuses any request without that value, or with a wrong one: 403 `origin_not_allowed`, with a warn line that names the reason (`origin_secret_missing` or `origin_secret_wrong`), never the value. The comparison is constant-time. So the Function URL cannot be used directly.
- **The visitor's IP:** only with a valid secret does sim-api take `x-viewer-ip` (written by the CloudFront Function) for its per-IP limit on wrong demo codes. Otherwise, and in the local entry, it uses the socket IP.
- **Locally:** the entry has no secret unless `SIM_ORIGIN_SECRET` is set, and says `Origin secret check: off` once at start-up.
- **Why an SSM String, and not a SecureString or Secrets Manager:**
  - CloudFront origin headers cannot resolve `ssm-secure` references; CloudFormation allows them only for a few password properties.
  - Secrets Manager would cost about $0.40 a month per secret per stage, against the zero-spend rule.
  - A String parameter is free, and readable only by whoever can read our own account (`ssm:GetParameter`, `cloudfront:GetDistributionConfig`). The secret's job is "only our distribution reaches the Function URL", and our own account is trusted.
- **Rotation**, with `/cold-reserve/<stage>/sim-api/origin-secret-previous` (`none` outside a rotation):
  1. Copy the current value into `origin-secret-previous` and write a new value (32+ characters) into `origin-secret`.
  2. Let sim-api pick both up: it reads its parameters when a container starts, so redeploy the sim-api stack or wait for idle containers to end.
  3. Redeploy the web stack, so CloudFront sends the new value.
  4. Set `origin-secret-previous` back to `none`.

## Not yet
- The family phone page.
- A custom domain.

Deploys are manual and reserved to the owner.
