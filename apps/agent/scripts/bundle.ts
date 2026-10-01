import { writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

// The AgentCore bundle (G1a): one CommonJS file for Node 22, everything inlined (the system prompt is
// already code, see scripts/prompts.ts). AgentCore direct code deployment accepts only a .js entry point,
// and ADOT tracing (if added later) only patches CommonJS: so app.js, with a package.json that says
// commonjs (the repo package is ESM). The infra stack (G1b) zips dist/agentcore/.
// https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-node.html
const result = await build({
  entryPoints: [new URL('../src/agentcore-entry.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  outfile: new URL('../dist/agentcore/app.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});
await writeFile(new URL('../dist/agentcore/package.json', import.meta.url), `${JSON.stringify({ type: 'commonjs' })}\n`);
const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`agentcore bundle: dist/agentcore/app.js, ${String(Math.round(bytes / 1024))} KiB`);
