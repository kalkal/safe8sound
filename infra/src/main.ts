import { App } from 'aws-cdk-lib';
import { buildApp, loadInfraConfig } from './index.js';

// Entry point for `cdk synth` (see cdk.json). Agents never deploy; CI synthesizes only.
const app = new App();
const config = loadInfraConfig((key) => app.node.tryGetContext(key));
if (!config.ok) {
  console.error(JSON.stringify({ level: 'error', component: 'infra', ...config.error }));
  process.exit(1);
}
buildApp(app, config.value).synth();
