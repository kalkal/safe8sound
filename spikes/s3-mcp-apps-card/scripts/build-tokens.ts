import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildTokens } from '../src/tokens/build.js';

const source = JSON.parse(await readFile(new URL('../tokens/tokens.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const result = await buildTokens(source);
if (!result.ok) {
  console.error(JSON.stringify({ level: 'error', component: 'design-tokens', ...result.error }));
  process.exit(1);
}

const out = new URL('../generated/', import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL('tokens.css', out), result.value.css);
await writeFile(
  new URL('token-names.ts', out),
  `// Generated from tokens/tokens.json. Do not edit.\nexport const TOKEN_NAMES = ${JSON.stringify(result.value.names, null, 2)} as const;\nexport type TokenName = (typeof TOKEN_NAMES)[number];\n`,
);
console.log(`tokens: ${result.value.names.length} custom properties -> generated/tokens.css`);
