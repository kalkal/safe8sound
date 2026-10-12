import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { AlexaSkillIdSchema, buildApp, loadInfraConfig } from './index.js';

// Entry point for `cdk synth` (see cdk.json). Agents never deploy; CI synthesizes only.
const app = new App();
const config = loadInfraConfig((key) => app.node.tryGetContext(key));
if (!config.ok) {
  console.error(JSON.stringify({ level: 'error', component: 'infra', ...config.error }));
  process.exit(1);
}
// The classic Alexa skill (#26): its ID only from the command line (`-c alexaSkillId=amzn1.ask.skill.<uuid>`),
// never from cdk.json; without it the skill stack is not part of the app.
const rawSkillId: unknown = app.node.tryGetContext('alexaSkillId');
const skillId = rawSkillId === undefined ? undefined : AlexaSkillIdSchema.safeParse(rawSkillId);
if (skillId !== undefined && !skillId.success) {
  console.error(JSON.stringify({ level: 'error', component: 'infra', code: 'invalid_config', message: 'alexaSkillId is not amzn1.ask.skill.<uuid>.' }));
  process.exit(1);
}
// The simulator website, built before the synth (root `pnpm synth`); the web stack refuses a missing build.
const siteDir = fileURLToPath(new URL('../../apps/alexa-sim/dist', import.meta.url));
buildApp(app, config.value, siteDir, skillId?.data).synth();
