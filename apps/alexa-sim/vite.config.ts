import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { cloudFrontStandIn } from './vite.cloudfront-preview.js';
import { siteTimingEnv } from './scripts/turn-timing.js';
import { phoneProxy, requirePhoneProxy } from './vite.phone-proxy.js';
import { CARD_BUNDLE_SOURCES, cardBundleProblem } from './scripts/card-bundle.js';

/** The headers the built site is served with (scripts/site-headers.ts), so `vite preview` applies the AWS CSP too. */
function previewHeaders(outDir: string): Record<string, string> {
  const file = join(outDir, 'security-headers.json');
  if (!existsSync(file)) return {};
  const headers = JSON.parse(readFileSync(file, 'utf8')) as { contentSecurityPolicy: string };
  return { 'Content-Security-Policy': headers.contentSecurityPolicy };
}


/**
 * Never serve or build with a card bundle older than its sources (#503): the dev server and every build stop at once and
 * say how to fix it. Not under Vitest (the unit tests read the cards' sources, not the bundle), nor for `vite preview`
 * (it serves a build that already passed this).
 */
function cardBundleFresh(): Plugin {
  const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  return {
    name: 'card-bundle-fresh',
    buildStart() {
      if (process.env['VITEST'] !== undefined) return;
      const problem = cardBundleProblem(
        at('../../packages/ui-cards/dist/card-app.js'),
        CARD_BUNDLE_SOURCES.map((source) => at(`../../${source}`)),
      );
      if (problem !== undefined) this.error(problem);
    },
  };
}
export default defineConfig(({ mode }) => {
  // The AWS build (K1, #242): the remote agent, and sim-api behind the same CloudFront distribution at /api. Not secrets:
  // the same for every stage, so they live here and not in a committed .env file.
  // Assigned, never defaulted: a VITE_AGENT=scripted left in the shell must never ship to AWS (#244 review).
  if (mode === 'aws') {
    process.env['VITE_AGENT'] = 'remote';
    process.env['VITE_SIM_API_URL'] = '/api';
    // The judges' site is an Amazon contest: always the Alexa layout, whatever the shell says (#432).
    process.env['VITE_LAYOUT'] = 'alexa-echo-show';
    // The browser's waits from the one timing table of a turn (#270), never a default.
    Object.assign(process.env, siteTimingEnv(JSON.parse(readFileSync(new URL('../../infra/cdk.json', import.meta.url), 'utf8'))));
  }
  const proxy = phoneProxy(process.env);
  requirePhoneProxy({ ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env }, proxy);
  return {
    // The site E2E only (K1, #244): CloudFront's /api/* in front of a real local sim-api.
    plugins: [react(), cardBundleFresh(), cloudFrontStandIn(process.env['SITE_E2E_SIM_API'], process.env['SITE_E2E_ORIGIN_SECRET'])],
    // Never ship source maps to the bucket (K1).
    build: { sourcemap: false },
    // The family phone's /phone/inbox, with its token added here on the dev server (never in the bundle).
    server: { host: '127.0.0.1', port: 5318, strictPort: true, ...(proxy && { proxy }) },
    preview: { headers: previewHeaders(process.env['SITE_E2E_OUT_DIR'] ?? 'dist-e2e') },
  };
});
