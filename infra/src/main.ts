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
// The classic Alexa skill (#26): its ID from the command line (`-c alexaSkillId=amzn1.ask.skill.<uuid>`) or the
// deployer's environment (`ALEXA_SKILL_ID`), never from cdk.json; without it the skill stack is not part of the app.
const rawSkillId: unknown = app.node.tryGetContext('alexaSkillId') ?? process.env['ALEXA_SKILL_ID'];
const skillId = rawSkillId === undefined || rawSkillId === '' ? undefined : AlexaSkillIdSchema.safeParse(rawSkillId);
if (skillId !== undefined && !skillId.success) {
  console.error(JSON.stringify({ level: 'error', component: 'infra', code: 'invalid_config', message: 'alexaSkillId is not amzn1.ask.skill.<uuid>.' }));
  process.exit(1);
}
// Left out, the skill keeps the code of its last deploy while the MCP replies move on: on 23 Oct it ran 13 Oct's
// strict schemas and refused every new field. Said on every synth that leaves it out, so a deploy never misses it.
if (skillId === undefined && config.value.alexa.stages.length > 0) {
  console.error(JSON.stringify({ level: 'warn', component: 'infra', code: 'alexa_skill_left_out', message: 'No alexaSkillId: the classic skill stack is not in this synth and its function keeps its last deployed code. Set ALEXA_SKILL_ID to deploy it with the rest.' }));
}
// The simulator website, built before the synth (root `pnpm synth`); the web stack refuses a missing build.
const siteDir = fileURLToPath(new URL('../../apps/alexa-sim/dist', import.meta.url));
buildApp(app, config.value, siteDir, skillId?.data).synth();
