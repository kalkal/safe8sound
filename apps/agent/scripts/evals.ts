// Runs the eval suite by hand (plan §10.2: before each milestone, never in CI).
// Usage: pnpm --filter @cold-reserve/agent evals   (AGENT_MODEL_PROVIDER=fake, the default)
import { createAgent } from '../src/agent.js';
import { loadAgentConfig } from '../src/config.js';
import { EVAL_SUITE } from '../src/evals/cases.js';
import { referencePolicy, stubTools } from '../src/evals/fake-world.js';
import { runEvals } from '../src/evals/harness.js';
import { FakeModel } from '../src/fake-model.js';

const config = loadAgentConfig(process.env);
if (!config.ok) {
  console.error(JSON.stringify(config.error));
  process.exit(1);
}
if (config.value.model.provider !== 'fake') {
  // Cost rule: Bedrock runs only after Spike S2, started by hand.
  console.error('Only the fake model is wired until Spike S2.');
  process.exit(2);
}

const cfg = config.value;
const report = await runEvals(EVAL_SUITE, () => createAgent({ config: cfg, model: new FakeModel(referencePolicy), tools: stubTools() }));
for (const r of report.results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(20)} ${r.toolCalls.join(',') || '-'}  ${r.error ?? ''}`);
console.log(JSON.stringify({ version: report.version, passRate: report.passRate, threshold: report.threshold, passed: report.passed }));
process.exitCode = report.passed ? 0 : 1;
