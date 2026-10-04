import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { buildApp, loadInfraConfig } from './index.js';

// Entry point for `cdk synth` (see cdk.json). Agents never deploy; CI synthesizes only.
const app = new App();
const config = loadInfraConfig((key) => app.node.tryGetContext(key));
if (!config.ok) {
  console.error(JSON.stringify({ level: 'error', component: 'infra', ...config.error }));
  process.exit(1);
}
// The simulator website, built before the synth (root `pnpm synth`); the web stack refuses a missing build.
const siteDir = fileURLToPath(new URL('../../apps/alexa-sim/dist', import.meta.url));
buildApp(app, config.value, siteDir).synth();
