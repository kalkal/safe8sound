import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { CARD_KINDS, checkBundleSize, isInlineSafe, renderCardHtml, type CardKind } from '../src/app/card-kinds.js';

// `pnpm --filter @cold-reserve/ui-cards build:card` (locally through `pnpm heavy`): builds the card
// bundle and fails when it grows past the budget, so it never grows silently, or when the real bundle
// could break out of its inline <script> in any card document.

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
await build({ root: packageRoot, configFile: fileURLToPath(new URL('../vite.card.config.ts', import.meta.url)), logLevel: 'warn' });

const bundlePath = fileURLToPath(new URL('../dist/card-app.js', import.meta.url));
const bytes = statSync(bundlePath).size;
const size = checkBundleSize(bytes);
if (!size.ok) {
  console.error(size.error);
  process.exit(1);
}
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const assets = { tokensCss: read('../../design-tokens/generated/tokens.css'), cardsCss: read('../src/cards.css'), cubesCss: read('../src/cubes.css'), bundleJs: readFileSync(bundlePath, 'utf8') };
const unsafe = (Object.keys(CARD_KINDS) as CardKind[]).filter((kind) => !isInlineSafe(renderCardHtml(assets, kind)));
if (unsafe.length > 0) {
  console.error(`The card bundle is not safe to inline in: ${unsafe.join(', ')}.`);
  process.exit(1);
}
console.log(`card bundle: ${String(size.value)} bytes, safe to inline in ${String(Object.keys(CARD_KINDS).length)} cards`);
