import { mkdir, writeFile } from 'node:fs/promises';
import { buildTokens } from '../src/build.js';
import { renderTokenModule } from '../src/module.js';
import { loadTokenSource } from '../src/source.js';

const result = await buildTokens(loadTokenSource());
if (!result.ok) {
  console.error(JSON.stringify({ level: 'error', component: 'design-tokens', ...result.error }));
  process.exit(1);
}

const out = new URL('../generated/', import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL('tokens.css', out), result.value.css);
await writeFile(new URL('tokens.ts', out), renderTokenModule(result.value.names));
console.log(`tokens: ${String(result.value.names.length)} custom properties -> generated/tokens.css, generated/tokens.ts`);
