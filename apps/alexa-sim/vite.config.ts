import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { cloudFrontStandIn } from './vite.cloudfront-preview.js';
import { phoneProxy, requirePhoneProxy } from './vite.phone-proxy.js';

/** The headers the built site is served with (scripts/site-headers.ts), so `vite preview` applies the AWS CSP too. */
function previewHeaders(outDir: string): Record<string, string> {
  const file = join(outDir, 'security-headers.json');
  if (!existsSync(file)) return {};
  const headers = JSON.parse(readFileSync(file, 'utf8')) as { contentSecurityPolicy: string };
  return { 'Content-Security-Policy': headers.contentSecurityPolicy };
}

export default defineConfig(({ mode }) => {
  // The AWS build (K1, #242): the remote agent, and sim-api behind the same CloudFront distribution at /api. Not secrets:
  // the same for every stage, so they live here and not in a committed .env file.
  // Assigned, never defaulted: a VITE_AGENT=scripted left in the shell must never ship to AWS (#244 review).
  if (mode === 'aws') {
    process.env['VITE_AGENT'] = 'remote';
    process.env['VITE_SIM_API_URL'] = '/api';
  }
  const proxy = phoneProxy(process.env);
  requirePhoneProxy({ ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env }, proxy);
  return {
    // The site E2E only (K1, #244): CloudFront's /api/* in front of a real local sim-api.
    plugins: [react(), cloudFrontStandIn(process.env['SITE_E2E_SIM_API'], process.env['SITE_E2E_ORIGIN_SECRET'])],
    // Never ship source maps to the bucket (K1).
    build: { sourcemap: false },
    // The family phone's /phone/inbox, with its token added here on the dev server (never in the bundle).
    server: { host: '127.0.0.1', port: 5318, strictPort: true, ...(proxy && { proxy }) },
    preview: { headers: previewHeaders(process.env['SITE_E2E_OUT_DIR'] ?? 'dist-e2e') },
  };
});
