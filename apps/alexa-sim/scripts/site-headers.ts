import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCardHtml } from '@cold-reserve/ui-cards/card-kinds';
import { siteHeaders } from './site-headers-lib.js';

// K1 (#242): after `vite build`, writes <outDir>/security-headers.json with the site's CSP. The card document is
// built from the very files the site inlines (card-documents.ts), so the hashes match what the browser runs.
// The infra reads this file at synth; the site E2E serves the build with it.

const outDir = process.argv[2];
if (outDir === undefined) {
  console.error('Usage: tsx scripts/site-headers.ts <outDir>');
  process.exit(1);
}
const read = (specifier: string) => readFileSync(fileURLToPath(import.meta.resolve(specifier)), 'utf8');
const card = renderCardHtml(
  { tokensCss: read('@cold-reserve/design-tokens/tokens.css'), cardsCss: read('@cold-reserve/ui-cards/cards.css'), bundleJs: read('@cold-reserve/ui-cards/card-app.js') },
  'plan',
);
const file = join(outDir, 'security-headers.json');
writeFileSync(file, `${JSON.stringify(siteHeaders(card), null, 2)}\n`);
console.log(`Wrote ${file}`);
