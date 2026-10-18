// Runs the eval suite by hand (plan §10.2: before each milestone, never in CI).
// Usage: pnpm --filter @cold-reserve/agent evals   (AGENT_MODEL_PROVIDER=fake, the default)
// Optional: EVAL_PROMPT_VERSION=v3 (compare an older prompt), EVAL_CASES=health-dizzy,status-no-emergency (a subset).
// The real model (cost rule: only by hand, with the owner's OK): AGENT_MODEL_PROVIDER=bedrock AGENT_MODEL_ID=… AGENT_REGION=…
// and EVAL_CONFIRM_COST=yes; the tools stay the fixed stubs of fake-world.ts, so only the model's answers vary.
import { createAgent } from '../src/agent.js';
import { loadAgentConfig } from '../src/config.js';
import { EVAL_SUITE } from '../src/evals/cases.js';
import { referencePolicy, stubTools } from '../src/evals/fake-world.js';
import { runEvals } from '../src/evals/harness.js';
import { FakeModel } from '../src/fake-model.js';
import { createModel } from '../src/model.js';
import { PROMPT_VERSION, promptVersionOf } from '../src/prompts.js';

const config = loadAgentConfig(process.env);
if (!config.ok) {
  console.error(JSON.stringify(config.error));
  process.exit(1);
}
const cfg = config.value;
if (cfg.model.provider !== 'fake' && process.env['EVAL_CONFIRM_COST'] !== 'yes') {
  console.error('The real model costs money: set EVAL_CONFIRM_COST=yes after the owner said yes.');
  process.exit(2);
}
const asked = process.env['EVAL_PROMPT_VERSION'];
const promptVersion = asked === undefined ? PROMPT_VERSION : promptVersionOf(asked);
if (promptVersion === undefined) {
  console.error(`No prompt version "${String(asked)}".`);
  process.exit(2);
}
const only = process.env['EVAL_CASES']?.split(',').map((id) => id.trim());
const suite = only === undefined ? EVAL_SUITE : { ...EVAL_SUITE, cases: EVAL_SUITE.cases.filter((c) => only.includes(c.id)) };
if (suite.cases.length === 0) {
  console.error('EVAL_CASES names no case of the suite.');
  process.exit(2);
}

const report = await runEvals(suite, () => createAgent({ config: cfg, model: createModel(cfg, () => new FakeModel(referencePolicy)), tools: stubTools(), promptVersion }));
for (const r of report.results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(20)} ${r.toolCalls.join(',') || '-'}  ${r.error ?? ''}`);
console.log(JSON.stringify({ model: cfg.model.provider, prompt: promptVersion, version: report.version, passRate: report.passRate, threshold: report.threshold, passed: report.passed }));
process.exitCode = report.passed ? 0 : 1;
