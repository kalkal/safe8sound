import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// The AgentCore bundle (G1a): one CommonJS file for Node 22, everything inlined (the system prompt is
// already code, see scripts/prompts.ts). AgentCore direct code deployment accepts only a .js entry point,
// and ADOT tracing (if added later) only patches CommonJS: so app.js, with a package.json that says
// commonjs (the repo package is ESM). Written to dist/agentcore/, or to `--out <dir>` (the infra stack
// builds it into its asset folder at synth time, G1b).
// https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-node.html
const outFlag = process.argv.indexOf('--out');
const outDir: string = (outFlag >= 0 ? process.argv[outFlag + 1] : undefined) ?? fileURLToPath(new URL('../dist/agentcore', import.meta.url));

await mkdir(outDir, { recursive: true });
const result = await build({
  entryPoints: [fileURLToPath(new URL('../src/agentcore-entry.ts', import.meta.url))],
  outfile: join(outDir, 'app.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});
await writeFile(join(outDir, 'package.json'), `${JSON.stringify({ type: 'commonjs' })}\n`);
const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`agentcore bundle: ${join(outDir, 'app.js')}, ${String(Math.round(bytes / 1024))} KiB`);
